# Run the timing bench on the device through SWD.  No flash writes.
#
#   openocd -f interface/stlink.cfg \
#     -c "transport select swd; adapter speed 1800; reset_config none" \
#     -f target/stm32h7x.cfg \
#     -c "set ::IMAGE build/bench_ram.bin; set ::BASE 0x00000000; set ::OUT r.bin; set ::CONTEXT current" \
#     -f run_bench.tcl
#
# ::IMAGE    image to load at ::BASE, or "" when it is already there (bank 2)
# ::BASE     image base: word 0 = stack top, word 1 = entry (see startup.S)
# ::CONTEXT  current = halt whatever firmware is running now
#            retrogo = reset-halt, then start Retro-Go from bank 2 the way the
#                      patched bootloader does, let it run ::BOOT_MS, then halt
# ::OUT      result table (8 KiB from 0x2001E000)
# ::TIMEOUT  ms to wait for the bench (default 60000)
# ::RESET    1 (default) = reset the chip at the end so the stock firmware
#            starts again; 0 = leave the chip halted

proc rd32 {a} { return [lindex [read_memory $a 32 1] 0] }
proc ipsr {} { return [expr {[dict get [get_reg {xpsr}] xpsr] & 0x1ff}] }
foreach {v d} {TIMEOUT 60000 RESET 1 BOOT_MS 4000 IMAGE ""} {
    if {![info exists ::$v]} { set ::$v $d }
}
set RES 0x2001E000
set ST_DONE 0x454E4F44
set ST_FAULT 0x544C5546

init

if {$::CONTEXT eq "retrogo"} {
    reset halt
    set sp [rd32 0x08100000]
    set pc [rd32 0x08100004]
    echo [format "RETROGO sp=%08x pc=%08x" $sp $pc]
    mww 0xE000ED08 0x08100000
    reg msp $sp
    reg pc [expr {$pc & ~1}]
    reg xpsr 0x01000000
    resume
    sleep $::BOOT_MS
}

# Halt in thread mode so that overwriting PC/xPSR leaves no active exception.
set tries 0
halt
while {[ipsr] != 0} {
    incr tries
    if {$tries > 100} { echo "ERROR could not halt in thread mode"; shutdown; return }
    resume
    sleep [expr {1 + $tries % 7}]
    halt
}
echo [format "HALTED pc=%08x after %d retries" [dict get [get_reg {pc}] pc] $tries]

# Freeze IWDG / WWDG while halted (restored at the end).
set apb4 [rd32 0x5C001054]
set apb3 [rd32 0x5C001034]
mww 0x5C001054 [expr {$apb4 | 0x00040000}]
mww 0x5C001034 [expr {$apb3 | 0x00000040}]

if {$::IMAGE ne ""} {
    load_image $::IMAGE $::BASE bin
    if {[catch {verify_image $::IMAGE $::BASE bin} err]} {
        echo "ERROR verify_image: $err"
        shutdown
        return
    }
    echo "LOADED $::IMAGE at $::BASE"
}
set sp [rd32 $::BASE]
set entry [rd32 [expr {$::BASE + 4}]]
echo [format "ENTRY sp=%08x entry=%08x" $sp $entry]
if {$sp != $RES} { echo "ERROR image base does not hold the bench"; shutdown; return }

mww $RES 0 16
reg primask 1
reg basepri 0
reg faultmask 0
reg control 0
reg msp $sp
reg xpsr 0x01000000
reg pc [expr {$entry & ~1}]
resume

set t 0
set status 0
while {$t < $::TIMEOUT} {
    sleep 250
    incr t 250
    set status [rd32 [expr {$RES + 8}]]
    if {$status == $ST_DONE || $status == $ST_FAULT} { break }
}
halt
set progress [rd32 [expr {$RES + 12}]]
set n [rd32 [expr {$RES + 16}]]
dump_image $::OUT $RES 0x2000
echo [format "STATUS %08x progress=%08x entries=%d after %d ms" $status $progress $n $t]
if {$status == $ST_DONE} { echo "RESULT DONE" } elseif {$status == $ST_FAULT} { echo "RESULT FAULT" } else { echo "RESULT TIMEOUT" }

if {$::RESET} {
    mww 0x5C001054 $apb4
    mww 0x5C001034 $apb3
    reset run
    echo "RESET"
} else {
    # Keep the bench's idle loop running: it feeds IWDG and WWDG.  A halted
    # core with the freeze bits cleared would be reset by the WWDG.
    resume
    echo "RESUMED (bench idle loop feeds the watchdogs)"
}
shutdown
