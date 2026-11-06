# On the stock first-boot "PRESS TIME BUTTON" screen: sample the selector
# byte, PC5 (TIME), PA2 (PGOOD) and PC8 (strap, analog when idle) for 25 s
# and print each change, while the user presses TIME.
init
proc rd {a} { return [lindex [read_memory $a 32 1] 0] }
set last ""
for {set i 0} {$i < 500} {incr i} {
    set flag [expr {([rd 0x2000ab90] >> 16) & 0xff}]
    set c [rd 0x58020810]; set a [rd 0x58020010]
    set s [format "flag=%d TIME(PC5)=%d PA2=%d PC8=%d" $flag [expr {($c>>5)&1}] [expr {($a>>2)&1}] [expr {($c>>8)&1}]]
    if {$s ne $last} { echo [format "t=%5.2fs %s" [expr {$i*0.05}] $s]; set last $s }
    sleep 50
}
shutdown
