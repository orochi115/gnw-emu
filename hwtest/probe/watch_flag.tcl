# Find what sets the stock firmware's byte at 0x2000ab92 (TIME pin selector:
# 1 = PC5, 0 = PA2).  Reset-halt, put a DWT write watchpoint on it, run, and
# log every hit (pc, lr, new value) until it becomes 1 or 20 s pass.
# OpenOCD's stm32h7x config freezes the watchdogs while the core is halted.
init
proc rd {a} { return [lindex [read_memory $a 32 1] 0] }
proc flagbyte {} { return [expr {([rd 0x2000ab90] >> 16) & 0xff}] }
reset halt
wp 0x2000ab92 1 w
resume
set hits 0
set t 0
while {$t < 200 && $hits < 12} {
    sleep 100
    incr t
    if {[stm32h7x.cpu0 curstate] eq "halted"} {
        incr hits
        echo [format "hit %d at %.1f s: pc=%s lr=%s r0=%s r1=%s r2=%s r3=%s flag=0x%02x" \
            $hits [expr {$t / 10.0}] [reg pc] [reg lr] [reg r0] [reg r1] [reg r2] [reg r3] [flagbyte]]
        if {[flagbyte] == 1} { break }
        resume
    }
}
echo [format "end: state=%s flag=0x%02x hits=%d" [stm32h7x.cpu0 curstate] [flagbyte] $hits]
rwp 0x2000ab92
if {[stm32h7x.cpu0 curstate] eq "halted"} { resume }
shutdown
