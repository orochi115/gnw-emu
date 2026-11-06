# Live battery ADC readings of the running stock firmware (no halt).
init
proc show {name addr} { echo [format "%-10s 0x%08x = 0x%08x (%d)" $name $addr [lindex [read_memory $addr 32 1] 0] [lindex [read_memory $addr 32 1] 0]] }
foreach n {1 2 3} {
  show ADC2_DR    0x40022140
  show ADC2_SMPR1 0x40022114
  show ADC2_CFGR  0x4002210c
  show ADC2_CFGR2 0x40022110
  show ADC1_DR    0x40022040
  show GPIOA_IDR  0x58020010
  show GPIOE_IDR  0x58021010
  sleep 500
}
shutdown
