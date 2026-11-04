/* Build B: programmed into the erased tail of flash bank 2, after Retro-Go. */
MEMORY
{
    CODE (rx) : ORIGIN = 0x08138000, LENGTH = 32K
    RAM (rw)  : ORIGIN = 0x20000000, LENGTH = 32K
}
INCLUDE common.ld
