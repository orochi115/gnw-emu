/*
 * Entry, vector table and exception handlers for the bench.
 *
 * The bench is not started through a reset: a debugger halts the running
 * firmware (so its clock, flash and OSPI setup stay in place), loads or
 * finds this image, sets PC = _entry and PRIMASK = 1, and resumes.
 * Word 0/1 of the image hold the stack top and _entry like a normal vector
 * table, so the OpenOCD script can read them from the image base.
 */
#include "bench.h"

        .syntax unified
        .cpu cortex-m7
        .fpu fpv5-d16
        .thumb

        .section .vectors, "a", %progbits
        .p2align 10
        .global vectors
vectors:
        .word   STACK_TOP
        .word   _entry
        .rept   14                      /* NMI .. SysTick */
        .word   fault_entry
        .endr
        .rept   37                      /* IRQ 0..36 */
        .word   fault_entry
        .endr
        .word   irq_handler             /* IRQ 37 (USART1): latency probe */
        .rept   160 - 38
        .word   fault_entry
        .endr

        .text
        .global _entry
        .type   _entry, %function
        .thumb_func
_entry:
        cpsid   i
        movs    r1, #0
        msr     basepri, r1
        cpsie   f                       /* clear FAULTMASK only */
        ldr     r0, =STACK_TOP
        msr     msp, r0
        msr     control, r1             /* MSP, privileged, FPCA = 0 */
        isb
        mov     sp, r0
        ldr     r1, =__bss_start
        ldr     r2, =__bss_end
        movs    r3, #0
1:      cmp     r1, r2
        bhs     2f
        str     r3, [r1], #4
        b       1b
2:      bl      bench_main
3:      b       3b
        .size   _entry, . - _entry

/* Faults and unexpected exceptions: hand the stacked frame to C. */
        .global fault_entry
        .type   fault_entry, %function
        .thumb_func
fault_entry:
        tst     lr, #4
        ite     eq
        mrseq   r0, msp
        mrsne   r0, psp
        mrs     r1, ipsr
        b       bench_fault
        .size   fault_entry, . - fault_entry

/* IRQ latency probe: first instruction after the vector fetch reads CYCCNT. */
        .global irq_handler
        .type   irq_handler, %function
        .thumb_func
irq_handler:
        ldr     r1, =0xE0001004
        ldr     r0, [r1]
        ldr     r2, =irq_t
        str     r0, [r2]
        ldr     r0, [r1]
        str     r0, [r2, #4]
        bx      lr
        .size   irq_handler, . - irq_handler

/*
 * void irq_probe(uint32_t out[2], int fp)
 * out[0] = CYCCNT just before the pend store, out[1] = CYCCNT on return to
 * thread mode.  With fp != 0 an FP instruction runs first so CONTROL.FPCA is
 * set and the exception entry uses the extended (lazy) frame.
 */
        .global irq_probe
        .type   irq_probe, %function
        .thumb_func
irq_probe:
        push    {r4-r6, lr}
        mov     r6, r0
        cbnz    r1, 1f
        movs    r3, #0
        msr     control, r3             /* FPCA = 0: basic frame */
        isb
        b       2f
1:      vmov.f32 s0, s0                 /* FPCA = 1: extended frame */
2:      ldr     r1, =0xE0001004
        ldr     r2, =0xE000E204         /* NVIC_ISPR1 */
        movs    r3, #(1 << 5)           /* IRQ 37 */
        cpsie   i
        ldr     r4, [r1]
        str     r3, [r2]
        dsb
        isb
        ldr     r5, [r1]
        cpsid   i
        str     r4, [r6]
        str     r5, [r6, #4]
        pop     {r4-r6, pc}
        .size   irq_probe, . - irq_probe
        .ltorg
