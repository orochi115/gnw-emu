/* Build A: loaded by the debugger into ITCM (0x0000-0x7fff; 0x8000+ is a test buffer). */
MEMORY
{
    CODE (rx) : ORIGIN = 0x00000000, LENGTH = 32K
    RAM (rw)  : ORIGIN = 0x20000000, LENGTH = 32K
}
INCLUDE common.ld
