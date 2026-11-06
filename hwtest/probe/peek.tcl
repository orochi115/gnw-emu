# Read live state without halting the core (AHB-AP reads while running).
# The stock firmware's TIME-pin selector flag, the input registers of the
# button/charger ports, and a few config registers that could tell boards apart.
init
proc show {name addr} { echo [format "%-12s 0x%08x = 0x%08x" $name $addr [lindex [read_memory $addr 32 1] 0]] }
echo [format "flag_ab92   0x2000ab90 = 0x%08x (byte +2)" [lindex [read_memory 0x2000ab90 32 1] 0]]
show GPIOA_IDR 0x58020010
show GPIOA_PUPDR 0x5802000c
show GPIOA_MODER 0x58020000
show GPIOC_IDR 0x58020810
show GPIOD_IDR 0x58020c10
show GPIOE_IDR 0x58021010
show DBGMCU_ID 0x5c001000
show RCC_RSR 0x58024530
show PWR_CPUCR 0x58024810
show FLASH_OPTSR 0x5200201c
show UID0 0x08fff800
show FLASHSIZE 0x08fff80c
shutdown
