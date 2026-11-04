/* Shared by link_ram.ld and link_bank2.ld (they define CODE and RAM). */
ENTRY(_entry)
SECTIONS
{
    .text : {
        KEEP(*(.vectors))
        *(.text*)
        . = ALIGN(32);
        *(.kernels)
        *(.rodata*)
        . = ALIGN(4);
    } > CODE
    .data : { *(.data*) } > RAM AT > CODE
    .bss (NOLOAD) : {
        __bss_start = .;
        *(.bss*) *(COMMON)
        . = ALIGN(4);
        __bss_end = .;
    } > RAM
    /DISCARD/ : { *(.ARM.exidx*) *(.comment) }
    ASSERT(SIZEOF(.data) == 0, "bench must not use initialised data")
}
