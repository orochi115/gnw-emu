/*
 * Cortex-M7 / STM32H7B0 timing bench for the Game & Watch.
 *
 * Runs inside whatever clock / flash / OSPI configuration the firmware left
 * behind (see startup.S), measures with DWT_CYCCNT and writes a result table
 * to RES_ADDR (bench.h).  A debugger reads it back.
 *
 * Safety rules (this runs on the user's only device):
 *   - never touches FLASH control registers or option bytes;
 *   - never sends OSPI commands (memory-mapped reads only);
 *   - never changes the RCC clock tree or voltage scaling (only peripheral
 *     clock gates, which a reset clears again);
 *   - never writes RTC or backup registers; SRD SRAM is saved and restored;
 *   - refreshes IWDG between tests in case the firmware started it.
 */
#include <stdint.h>
#include "bench.h"
#include "kernels.h"

#define REG(a)          (*(volatile uint32_t *)(uintptr_t)(a))

/* Core */
#define DWT_CTRL        REG(0xE0001000)
#define DWT_CYCCNT      REG(0xE0001004)
#define DWT_LAR         REG(0xE0001FB0)
#define DEMCR           REG(0xE000EDFC)
#define SYST_CSR        REG(0xE000E010)
#define SYST_RVR        REG(0xE000E014)
#define SYST_CVR        REG(0xE000E018)
#define SCB_ICSR        REG(0xE000ED04)
#define SCB_VTOR        REG(0xE000ED08)
#define SCB_CCR         REG(0xE000ED14)
#define SCB_CFSR        REG(0xE000ED28)
#define SCB_HFSR        REG(0xE000ED2C)
#define SCB_MMFAR       REG(0xE000ED34)
#define SCB_BFAR        REG(0xE000ED38)
#define SCB_CCSIDR      REG(0xE000ED80)
#define SCB_CSSELR      REG(0xE000ED84)
#define SCB_CPACR       REG(0xE000ED88)
#define MPU_CTRL        REG(0xE000ED94)
#define MPU_RNR         REG(0xE000ED98)
#define MPU_RBAR        REG(0xE000ED9C)
#define MPU_RASR        REG(0xE000EDA0)
#define SCB_ICIALLU     REG(0xE000EF50)
#define SCB_DCISW       REG(0xE000EF60)
#define SCB_DCCMVAC     REG(0xE000EF68)
#define SCB_DCCISW      REG(0xE000EF74)
#define NVIC_ISER(n)    REG(0xE000E100 + 4 * (n))
#define NVIC_ICER(n)    REG(0xE000E180 + 4 * (n))
#define NVIC_ICPR(n)    REG(0xE000E280 + 4 * (n))
#define NVIC_IPR8(n)    (*(volatile uint8_t *)(0xE000E400 + (n)))

/* Peripherals */
#define RCC_BDCR        REG(0x58024470)
#define RCC_AHB3ENR     REG(0x58024534)
#define RCC_AHB1ENR     REG(0x58024538)
#define RCC_AHB2ENR     REG(0x5802453C)
#define RCC_AHB4ENR     REG(0x58024540)
#define RCC_APB1LENR    REG(0x58024548)
#define IWDG_KR         REG(0x58004800)
#define RTC_DR          REG(0x58004004)
#define RTC_SSR         REG(0x58004008)
#define RTC_ICSR        REG(0x5800400C)
#define RTC_PRER        REG(0x58004010)
#define OSPI_CR         REG(0x52005000)
#define LTDC_TWCR       REG(0x50001014)
#define LTDC_GCR        REG(0x50001018)
#define LTDC_CPSR       REG(0x50001044)
#define LTDC_CDSR       REG(0x50001048)
#define TIM2_CR1        REG(0x40000000)
#define TIM2_EGR        REG(0x40000014)
#define TIM2_CNT        REG(0x40000024)
#define TIM2_PSC        REG(0x40000028)
#define TIM2_ARR        REG(0x4000002C)
#define DMA2D(o)        REG(0x52001000 + (o))
#define DMA1_BASE       0x40020000u
#define CRYP(o)         REG(0x48021000 + (o))

/* Buffers (see README in this directory for the memory map) */
#define ITCM_BUF        0x00008000u
#define DTCM_BUF        0x20008000u
#define AXI_BUF         0x24080000u
#define AXI_EXEC        0x24090000u
#define AXI_BG          0x24040000u     /* DMA2D background, 150 KiB */
#define AXI_SRC         0x240A0000u     /* DMA2D/DMA source, 150 KiB */
#define AXI_DST         0x240D0000u     /* DMA2D/DMA destination, 150 KiB */
#define AXI_SRD_SAVE    0x240F8000u     /* copy of SRD SRAM, 32 KiB */
#define AHB_BUF         0x30000000u
#define AHB_EXEC        0x30010000u
#define SRD_BASE        0x38000000u
#define SRD_SIZE        0x8000u
#define SRD_BUF         0x38000000u
#define SRD_EXEC        0x38006000u

#ifdef BENCH_BANK2
#define BUILD_ID BUILD_BANK2
#else
#define BUILD_ID BUILD_RAM
#endif

#define RUNS 3

extern uint32_t vectors[];
void irq_probe(uint32_t out[2], int fp);

static struct header *const H = (struct header *)RES_ADDR;
volatile uint32_t irq_t[2];

static const uint32_t snap_addr[] = {
#define S(name, addr) addr,
#include "snap.def"
#undef S
};

static inline void dsb(void) { __asm volatile("dsb" ::: "memory"); }
static inline void isb(void) { __asm volatile("isb" ::: "memory"); }
/*
 * Feed the watchdogs.  The stock firmware runs the window watchdog
 * (WWDG_CR.WDGA = 1, it cannot be stopped): reload only once the counter
 * is below the window value W, because an early reload also resets.
 */
#define WWDG_CR         REG(0x50003000)
#define WWDG_CFR        REG(0x50003004)
static inline void kick(void)
{
    IWDG_KR = 0xAAAA;
    uint32_t cr = WWDG_CR;
    if ((cr & 0x80) && (cr & 0x7F) < (WWDG_CFR & 0x7F)) {
        WWDG_CR = 0xFF;
    }
}

static void copy32(uint32_t dst, uint32_t src, uint32_t len)
{
    volatile uint32_t *d = (volatile uint32_t *)dst;
    const volatile uint32_t *s = (const volatile uint32_t *)src;
    for (uint32_t i = 0; i < len / 4; i++) {
        d[i] = s[i];
    }
}

/* Fill with a constant word. */
static void fill32(uint32_t dst, uint32_t len, uint32_t v)
{
    volatile uint32_t *d = (volatile uint32_t *)dst;
    for (uint32_t i = 0; i < len / 4; i++) {
        d[i] = v;
    }
}

/* ------------------------------------------------------------ caches */
static void icache_off(void)
{
    dsb(); isb();
    SCB_CCR &= ~(1u << 17);
    SCB_ICIALLU = 0;
    dsb(); isb();
}

static void icache_on(void)
{
    dsb(); isb();
    SCB_ICIALLU = 0;
    dsb(); isb();
    SCB_CCR |= 1u << 17;
    dsb(); isb();
}

static void dcache_setway(volatile uint32_t *op)
{
    SCB_CSSELR = 0;
    dsb();
    uint32_t ccsidr = SCB_CCSIDR;
    uint32_t sets = (ccsidr >> 13) & 0x7FFF;
    do {
        uint32_t ways = (ccsidr >> 3) & 0x3FF;
        do {
            *op = ((sets << 5) & 0x3FE0) | ((ways << 30) & 0xC0000000);
        } while (ways-- != 0);
    } while (sets-- != 0);
    dsb();
}

static void dcache_off(void)
{
    SCB_CSSELR = 0;
    dsb();
    SCB_CCR &= ~(1u << 16);
    dsb();
    dcache_setway(&SCB_DCCISW);        /* clean + invalidate */
    isb();
}

static void dcache_on(void)
{
    dcache_setway(&SCB_DCISW);         /* invalidate (cache was off) */
    SCB_CCR |= 1u << 16;
    dsb(); isb();
}

static void set_cfg(int cfg)
{
    if (cfg == CFG_ON) {
        icache_on();
        dcache_on();
    } else {
        dcache_off();
        icache_off();
    }
}

/* ------------------------------------------------------------ results */
static void record(int test, int region, int cfg, uint32_t iters, uint32_t ops,
                   uint32_t cmin, uint32_t cmax)
{
    if (H->nentries >= MAX_ENTRIES) {
        return;
    }
    struct entry *e = &H->e[H->nentries];
    e->test = test;
    e->region = region;
    e->cfg = cfg;
    e->iters = iters;
    e->ops = ops;
    e->cmin = cmin;
    e->cmax = cmax;
    dsb();
    H->nentries++;
}

static void progress(int test, int region, int cfg)
{
    H->progress = test | region << 8 | cfg << 16 | H->nentries << 20;
    dsb();
    kick();
}

void bench_fault(uint32_t *frame, uint32_t ipsr)
{
    H->fault[0] = SCB_CFSR;
    H->fault[1] = SCB_HFSR;
    H->fault[2] = SCB_MMFAR;
    H->fault[3] = SCB_BFAR;
    H->fault[4] = ipsr;
    H->fault[5] = frame[0];
    H->fault[6] = frame[1];
    H->fault[7] = frame[2];
    H->fault[8] = frame[3];
    H->fault[9] = frame[4];
    H->fault[10] = frame[5];
    H->fault[11] = frame[6];
    H->status = ST_FAULT;
    dsb();
    for (;;) {
        kick();
    }
}

/* ------------------------------------------------------------ kernels */
static uint32_t time_kernel(kern_t f, uint32_t iters, uint32_t a1, uint32_t a2,
                            uint32_t a3)
{
    uint32_t t0 = DWT_CYCCNT;
    f(iters, a1, a2, a3);
    return DWT_CYCCNT - t0;
}

/* One warm-up call, then RUNS measured calls; records min and max. */
static void run_kernel(int test, int region, int cfg, kern_t f, uint32_t reps,
                       uint32_t iters, uint32_t a1, uint32_t a2, uint32_t a3)
{
    uint32_t mn = 0xFFFFFFFF, mx = 0;

    progress(test, region, cfg);
    time_kernel(f, iters, a1, a2, a3);
    for (int i = 0; i < RUNS; i++) {
        uint32_t c = time_kernel(f, iters, a1, a2, a3);
        mn = c < mn ? c : mn;
        mx = c > mx ? c : mx;
    }
    record(test, region, cfg, iters, reps * iters, mn, mx);
}

/* Copy a (position independent) kernel to dst and return a callable pointer. */
static kern_t place(void *fn, char *end, uint32_t dst)
{
    uint32_t start = (uint32_t)(uintptr_t)fn & ~1u;
    uint32_t len = ((uint32_t)(uintptr_t)end - start + 3) & ~3u;
    copy32(dst, start, len);
    dsb();
    /* With the D-cache on the copy may sit in dirty lines: write it out. */
    for (uint32_t a = dst & ~31u; a < dst + len; a += 32) {
        SCB_DCCMVAC = a;
    }
    dsb();
    SCB_ICIALLU = 0;
    dsb(); isb();
    return (kern_t)(uintptr_t)(dst | 1);
}

#define K(name) (kern_t)k_##name, K_##name##_REPS

static void core_tests(int cfg)
{
    const uint32_t it = 200;

    run_kernel(0, R_CODE, cfg, (kern_t)k_empty, 1, it, 0, 0, 0);
    run_kernel(1, R_CODE, cfg, K(nop), it, 0, 0, 0);
    run_kernel(2, R_CODE, cfg, K(add_dep), it, 0, 0, 0);
    run_kernel(3, R_CODE, cfg, K(add_indep), it, 0, 0, 0);
    run_kernel(4, R_CODE, cfg, K(addw_indep), it, 0, 0, 0);
    run_kernel(5, R_CODE, cfg, K(mul_dep), it, 0, 0, 0);
    run_kernel(6, R_CODE, cfg, K(mul_indep), it, 0, 0, 0);
    run_kernel(7, R_CODE, cfg, K(mla_dep), it, 0, 0, 0);
    run_kernel(8, R_CODE, cfg, K(udiv), it, 0, 0xFFFFFFFF, 1);
    run_kernel(9, R_CODE, cfg, K(udiv), it, 0, 1, 0xFFFFFFFF);
    run_kernel(10, R_CODE, cfg, K(sdiv), it, 0, 0x7FFFFFFF, 1);
    run_kernel(11, R_CODE, cfg, K(b_taken), it, 0, 0, 0);
    run_kernel(12, R_CODE, cfg, K(vadd_dep), it, 0, 0, 0);
    run_kernel(13, R_CODE, cfg, K(vmul_dep), it, 0, 0, 0);
    run_kernel(14, R_CODE, cfg, K(vfma_dep), it, 0, 0, 0);
    run_kernel(15, R_CODE, cfg, K(vdiv_dep), it, 0, 0, 0);
    run_kernel(16, R_CODE, cfg, K(vsqrt_dep), it, 0, 0, 0);
    run_kernel(17, R_CODE, cfg, K(vadd64_dep), it, 0, 0, 0);
    run_kernel(18, R_CODE, cfg, K(vdiv64_dep), it, 0, 0, 0);
    run_kernel(19, R_CODE, cfg, K(vsqrt64_dep), it, 0, 0, 0);
    run_kernel(21, R_CODE, cfg, K(alu2_lat), it, DTCM_BUF, 0, 0);
}

struct region {
    uint8_t id, writable;
    uint32_t buf, span;
};

static int ospi_mapped(void)
{
    return (RCC_AHB3ENR & (1u << 14)) && (OSPI_CR & 1) &&
           ((OSPI_CR >> 28) & 3) == 3;
}

static void mem_tests(int cfg)
{
    static const struct region regions[] = {
        { R_ITCM, 1, ITCM_BUF, 0x8000 },
        { R_DTCM, 1, DTCM_BUF, 0x10000 },
        { R_AXI, 1, AXI_BUF, 0x10000 },
        { R_AHB, 1, AHB_BUF, 0x10000 },
        { R_SRD, 1, SRD_BUF, 0x6000 },
        { R_FLASH1, 0, 0x08000000, 0x10000 },
        { R_FLASH2, 0, 0x08100000, 0x10000 },
        { R_OSPI, 0, 0x90000000, 0x10000 },
    };
    const uint32_t it = 200;

    for (unsigned i = 0; i < sizeof(regions) / sizeof(regions[0]); i++) {
        const struct region *r = &regions[i];
        if (r->id == R_OSPI && !ospi_mapped()) {
            continue;
        }
        if (r->writable) {
            /*
             * Zero the buffer: ld_lat and ld_lat_line add the loaded value to
             * the address twice (r1 ^= v ^ v), which works for any content,
             * but zero keeps the data identical between runs and machines.
             */
            fill32(r->buf, r->span, 0);
        }
        run_kernel(20, r->id, cfg, K(ld_lat), it, r->buf, 0, 0);
        run_kernel(22, r->id, cfg, K(ld_tput), it, r->buf, 0, 0);
        run_kernel(23, r->id, cfg, K(ld_seq), it, r->buf, r->span, 0);
        run_kernel(24, r->id, cfg, K(ld_line), it, r->buf, r->span, 0);
        run_kernel(25, r->id, cfg, K(ld_lat_line), it, r->buf, r->span, 0);
        run_kernel(26, r->id, cfg, K(ldm_seq), it, r->buf, r->span, 0);
        if (r->writable) {
            run_kernel(27, r->id, cfg, K(st_seq), it, r->buf, r->span, 0);
            run_kernel(28, r->id, cfg, K(st_same), it, r->buf, 0, 0);
        }
    }
}

static void fetch_tests(int cfg)
{
    static const struct { uint8_t id; uint32_t exec; } where[] = {
        { R_CODE, 0 },
        { R_ITCM, ITCM_BUF },
        { R_AXI, AXI_EXEC },
        { R_AHB, AHB_EXEC },
        { R_SRD, SRD_EXEC },
    };
    const uint32_t it = 20;

    for (unsigned i = 0; i < sizeof(where) / sizeof(where[0]); i++) {
        kern_t nop = (kern_t)k_fetch_nop, addw = (kern_t)k_fetch_addw;
        kern_t empty = (kern_t)k_empty;
        if (where[i].exec) {
            nop = place((void *)k_fetch_nop, k_fetch_nop_end, where[i].exec);
            run_kernel(29, where[i].id, cfg, nop, K_fetch_nop_REPS, it, 0, 0, 0);
            addw = place((void *)k_fetch_addw, k_fetch_addw_end, where[i].exec);
            run_kernel(30, where[i].id, cfg, addw, K_fetch_addw_REPS, it, 0, 0, 0);
            empty = place((void *)k_empty, k_empty_end, where[i].exec);
            run_kernel(31, where[i].id, cfg, empty, 1, it, 0, 0, 0);
        } else {
            run_kernel(29, R_CODE, cfg, nop, K_fetch_nop_REPS, it, 0, 0, 0);
            run_kernel(30, R_CODE, cfg, addw, K_fetch_addw_REPS, it, 0, 0, 0);
            run_kernel(31, R_CODE, cfg, empty, 1, it, 0, 0, 0);
        }
    }
}

/* ------------------------------------------------------------ clocks */
static void spin(uint32_t cycles)
{
    uint32_t t0 = DWT_CYCCNT;
    while (DWT_CYCCNT - t0 < cycles) {
    }
}

static uint32_t rtc_ssr(void)
{
    uint32_t v = RTC_SSR;
    (void)RTC_DR;                       /* unlock the shadow registers */
    return v;
}

static void clock_tests(void)
{
    /* CPU clock against the RTC (LSE). */
    progress(40, 0, 0);
    if ((RCC_BDCR & (1u << 15)) && !(RTC_ICSR & (1u << 6))) {
        uint32_t prer = RTC_PRER;
        uint32_t div_a = ((prer >> 16) & 0x7F) + 1;
        uint32_t ticks = 32768 / div_a / 2;          /* about 0.5 s */
        uint32_t s = rtc_ssr(), t0 = DWT_CYCCNT, ok = 1;
        while (rtc_ssr() == s) {
            if (DWT_CYCCNT - t0 > 0x40000000) { ok = 0; break; }
        }
        t0 = DWT_CYCCNT;
        for (uint32_t n = 0; ok && n < ticks; n++) {
            s = rtc_ssr();
            while (rtc_ssr() == s) {
                if (DWT_CYCCNT - t0 > 0x7FFFFFFF) { ok = 0; break; }
            }
            kick();
        }
        uint32_t c = DWT_CYCCNT - t0;
        if (ok) {
            record(40, 0, 0, div_a, ticks, c, c);
        }
    }

    /* SysTick, processor clock and reference clock (HCLK / 8). */
    for (int ref = 0; ref < 2; ref++) {
        progress(41 + ref, 0, 0);
        SYST_CSR = 0;
        SYST_RVR = 0xFFFFFF;
        SYST_CVR = 0;
        SYST_CSR = ref ? 1 : 5;
        spin(1000);
        uint32_t t0 = DWT_CYCCNT, s0 = SYST_CVR;
        spin(4000000);
        uint32_t s1 = SYST_CVR, t1 = DWT_CYCCNT;
        SYST_CSR = 0;
        record(41 + ref, 0, 0, 0, (s0 - s1) & 0xFFFFFF, t1 - t0, t1 - t0);
    }

    /* TIM2 (APB1 timer clock). */
    progress(43, 0, 0);
    {
        uint32_t started = 0;
        RCC_APB1LENR |= 1;
        (void)RCC_APB1LENR;
        if (!(TIM2_CR1 & 1)) {
            TIM2_PSC = 0;
            TIM2_ARR = 0xFFFFFFFF;
            TIM2_EGR = 1;
            TIM2_CR1 = 1;
            started = 1;
        }
        spin(1000);
        uint32_t t0 = DWT_CYCCNT, c0 = TIM2_CNT;
        spin(4000000);
        uint32_t c1 = TIM2_CNT, t1 = DWT_CYCCNT;
        record(43, 0, 0, TIM2_PSC | started << 31, c1 - c0, t1 - t0, t1 - t0);
        if (started) {
            TIM2_CR1 = 0;
        }
    }

    /* LTDC frame and line period (only if the firmware runs the LTDC). */
    if (LTDC_GCR & 1) {
        progress(44, 0, 0);
        uint32_t t0 = DWT_CYCCNT, ok = 1;
        for (int n = -1; n < 4 && ok; n++) {
            while ((LTDC_CDSR & 4) && ok) { ok = DWT_CYCCNT - t0 < 0x40000000; }
            while (!(LTDC_CDSR & 4) && ok) { ok = DWT_CYCCNT - t0 < 0x40000000; }
            if (n < 0) {
                t0 = DWT_CYCCNT;
            }
        }
        uint32_t c = DWT_CYCCNT - t0;
        if (ok) {
            record(44, 0, 0, LTDC_TWCR, 4, c, c);
        }

        progress(45, 0, 0);
        t0 = DWT_CYCCNT;
        ok = 1;
        while ((LTDC_CPSR & 0xFFFF) == 10 && ok) { ok = DWT_CYCCNT - t0 < 0x40000000; }
        while ((LTDC_CPSR & 0xFFFF) != 10 && ok) { ok = DWT_CYCCNT - t0 < 0x40000000; }
        uint32_t t1 = DWT_CYCCNT;
        while ((LTDC_CPSR & 0xFFFF) != 110 && ok) { ok = DWT_CYCCNT - t0 < 0x40000000; }
        c = DWT_CYCCNT - t1;
        if (ok) {
            record(45, 0, 0, LTDC_TWCR, 100, c, c);
        }
    }
}

/* ------------------------------------------------------------ peripherals */
static uint32_t dma2d_run(uint32_t cr)
{
    DMA2D(0x08) = 0x3F;                 /* IFCR */
    uint32_t t0 = DWT_CYCCNT;
    DMA2D(0x00) = cr | 1;
    while (!(DMA2D(0x04) & 3)) {
        if (DWT_CYCCNT - t0 > 0x10000000) {
            DMA2D(0x00) = 4;            /* ABORT */
            return 0xFFFFFFFF;
        }
    }
    uint32_t c = DWT_CYCCNT - t0;
    uint32_t err = DMA2D(0x04) & 1;
    DMA2D(0x08) = 0x3F;
    return err ? 0xFFFFFFFF : c;
}

static void dma2d_test(int test, uint32_t cr, uint32_t pixels)
{
    uint32_t mn = 0xFFFFFFFF, mx = 0;
    progress(test, 0, 0);
    for (int i = 0; i < RUNS; i++) {
        uint32_t c = dma2d_run(cr);
        if (c == 0xFFFFFFFF) {
            record(test, 0, 0, 0xFFFFFFFF, pixels, 0, 0);
            return;
        }
        mn = c < mn ? c : mn;
        mx = c > mx ? c : mx;
    }
    record(test, 0, 0, 0, pixels, mn, mx);
}

static void dma2d_tests(void)
{
    RCC_AHB3ENR |= 1u << 4;
    (void)RCC_AHB3ENR;
    uint32_t t0 = DWT_CYCCNT;
    while ((DMA2D(0x00) & 1) && DWT_CYCCNT - t0 < 0x10000000) {
    }
    if (DMA2D(0x00) & 1) {
        DMA2D(0x00) = 4;
        spin(100000);
    }
    fill32(AXI_SRC, 320 * 240 * 2, 0x12345678);
    fill32(AXI_BG, 320 * 240 * 2, 0x0F0F0F0F);

    /* R2M: fill 320x240 RGB565 */
    DMA2D(0x34) = 2;                    /* OPFCCR RGB565 */
    DMA2D(0x38) = 0x1234;               /* OCOLR */
    DMA2D(0x3C) = AXI_DST;              /* OMAR */
    DMA2D(0x40) = 0;                    /* OOR */
    DMA2D(0x44) = 320u << 16 | 240;     /* NLR */
    dma2d_test(50, 3u << 16, 320 * 240);

    /* M2M: copy 320x240 RGB565 */
    DMA2D(0x0C) = AXI_SRC;              /* FGMAR */
    DMA2D(0x10) = 0;                    /* FGOR */
    DMA2D(0x1C) = 2;                    /* FGPFCCR RGB565 */
    dma2d_test(51, 0u << 16, 320 * 240);

    /* M2M with PFC: 160x240 ARGB8888 -> RGB565 */
    DMA2D(0x1C) = 0;                    /* FG ARGB8888 */
    DMA2D(0x44) = 160u << 16 | 240;
    dma2d_test(52, 1u << 16, 160 * 240);

    /* Blend: FG 160x240 ARGB8888 over BG RGB565 -> RGB565 */
    DMA2D(0x14) = AXI_BG;               /* BGMAR */
    DMA2D(0x18) = 0;                    /* BGOR */
    DMA2D(0x24) = 2;                    /* BGPFCCR RGB565 */
    dma2d_test(53, 2u << 16, 160 * 240);
}

static void dma1_tests(void)
{
    RCC_AHB1ENR |= 1;
    (void)RCC_AHB1ENR;
    /* Pick an idle stream, highest first (the firmware's SAI uses low ones). */
    int s;
    for (s = 7; s >= 0; s--) {
        if (!(REG(DMA1_BASE + 0x10 + 0x18 * s) & 1)) {
            break;
        }
    }
    if (s < 0) {
        return;
    }
    uint32_t base = DMA1_BASE + 0x10 + 0x18 * s;
    uint32_t isr = DMA1_BASE + (s >= 4 ? 0x04 : 0x00);
    uint32_t ifcr = DMA1_BASE + (s >= 4 ? 0x0C : 0x08);
    static const uint8_t shift[4] = { 0, 6, 16, 22 };
    uint32_t sh = shift[s & 3];
    const uint32_t words = 16384;       /* 64 KiB */

    fill32(AXI_SRC, words * 4, 0xA5A50000);
    for (int burst = 0; burst < 2; burst++) {
        uint32_t mn = 0xFFFFFFFF, mx = 0, bad = 0;
        progress(54 + burst, 0, 0);
        for (int i = 0; i < RUNS && !bad; i++) {
            REG(base) = 0;
            while (REG(base) & 1) {
            }
            REG(ifcr) = 0x3Du << sh;
            REG(base + 0x08) = AXI_SRC;             /* PAR */
            REG(base + 0x0C) = AXI_DST;             /* M0AR */
            REG(base + 0x04) = words;               /* NDTR */
            REG(base + 0x14) = 0x7;                 /* FIFO, full threshold */
            uint32_t cr = 2u << 6 | 1u << 9 | 1u << 10 | 2u << 11 | 2u << 13 |
                          2u << 16;
            if (burst) {
                cr |= 1u << 21 | 1u << 23;          /* INCR4 bursts */
            }
            REG(base) = cr;
            uint32_t t0 = DWT_CYCCNT;
            REG(base) = cr | 1;
            uint32_t f;
            while (!((f = REG(isr) >> sh) & 0x28)) {    /* TCIF | TEIF */
                if (DWT_CYCCNT - t0 > 0x10000000) {
                    f = 0x08;
                    break;
                }
            }
            uint32_t c = DWT_CYCCNT - t0;
            if (f & 0x08) {
                bad = 1;
            }
            mn = c < mn ? c : mn;
            mx = c > mx ? c : mx;
            REG(base) = 0;
            REG(ifcr) = 0x3Du << sh;
        }
        record(54 + burst, 0, 0, bad ? 0xFFFFFFFF : (uint32_t)s, words, mn, mx);
    }
}

static void cryp_test(void)
{
    const uint32_t blocks = 64;
    uint32_t mn = 0xFFFFFFFF, mx = 0;

    RCC_AHB2ENR |= 1u << 4;
    (void)RCC_AHB2ENR;
    progress(56, 0, 0);
    for (int run = 0; run < RUNS; run++) {
        CRYP(0x00) = 0;
        /* Throw-away test key; nothing to do with the firmware's keys. */
        CRYP(0x30) = 0x00010203;
        CRYP(0x34) = 0x04050607;
        CRYP(0x38) = 0x08090A0B;
        CRYP(0x3C) = 0x0C0D0E0F;
        CRYP(0x00) = 4u << 3;                       /* AES-ECB encrypt */
        CRYP(0x00) |= 1u << 14;                     /* FFLUSH */
        CRYP(0x00) |= 1u << 15;                     /* CRYPEN */
        uint32_t t0 = DWT_CYCCNT, sink = 0;
        for (uint32_t b = 0; b < blocks; b++) {
            for (int w = 0; w < 4; w++) {
                while (!(CRYP(0x04) & 2)) {         /* IFNF */
                }
                CRYP(0x08) = b * 4 + w;
            }
            for (int w = 0; w < 4; w++) {
                uint32_t t = DWT_CYCCNT;
                while (!(CRYP(0x04) & 4)) {         /* OFNE */
                    if (DWT_CYCCNT - t > 1000000) {
                        CRYP(0x00) = 0;
                        record(56, 0, 0, 0xFFFFFFFF, blocks, 0, 0);
                        return;
                    }
                }
                sink += CRYP(0x0C);
            }
        }
        uint32_t c = DWT_CYCCNT - t0;
        CRYP(0x00) = 0;
        (void)sink;
        mn = c < mn ? c : mn;
        mx = c > mx ? c : mx;
    }
    record(56, 0, 0, 0, blocks, mn, mx);
}

static void irq_tests(int cfg)
{
    uint32_t out[2];

    NVIC_IPR8(37) = 0;
    NVIC_ICPR(1) = 1u << 5;
    NVIC_ISER(1) = 1u << 5;
    for (int fp = 0; fp < 2; fp++) {
        uint32_t emn = 0xFFFFFFFF, emx = 0, rmn = 0xFFFFFFFF, rmx = 0;
        progress(60 + 2 * fp, 0, cfg);
        for (int i = 0; i < 9; i++) {
            irq_t[0] = irq_t[1] = 0;
            irq_probe(out, fp);
            if (i == 0) {
                continue;               /* warm-up */
            }
            uint32_t e = irq_t[0] - out[0], r = out[1] - irq_t[1];
            emn = e < emn ? e : emn;
            emx = e > emx ? e : emx;
            rmn = r < rmn ? r : rmn;
            rmx = r > rmx ? r : rmx;
        }
        record(60 + 2 * fp, 0, cfg, 0, 1, emn, emx);
        record(61 + 2 * fp, 0, cfg, 0, 1, rmn, rmx);
    }
    NVIC_ICER(1) = 1u << 5;
    NVIC_ICPR(1) = 1u << 5;
}

static void memcpy_test(int cfg)
{
    const uint32_t bytes = 0x10000;
    uint32_t mn = 0xFFFFFFFF, mx = 0;
    progress(64, 0, cfg);
    for (int i = 0; i < RUNS + 1; i++) {
        uint32_t t0 = DWT_CYCCNT;
        copy32(AXI_DST, AXI_SRC, bytes);
        uint32_t c = DWT_CYCCNT - t0;
        if (i == 0) {
            continue;
        }
        mn = c < mn ? c : mn;
        mx = c > mx ? c : mx;
    }
    record(64, R_AXI, cfg, 0, bytes, mn, mx);
}

/* ------------------------------------------------------------ main */
static void quiesce(void)
{
    SYST_CSR = 0;
    SCB_ICSR = 1u << 25 | 1u << 27;    /* PENDSTCLR, PENDSVCLR */
    for (int i = 0; i < 5; i++) {
        NVIC_ICER(i) = 0xFFFFFFFF;
        NVIC_ICPR(i) = 0xFFFFFFFF;
    }
    /* Stop the firmware's DMA streams (SAI audio) so they don't add bus traffic. */
    for (int c = 0; c < 2; c++) {
        for (int s = 0; s < 8; s++) {
            REG(DMA1_BASE + 0x400 * c + 0x10 + 0x18 * s) &= ~1u;
        }
    }
    dsb();
    MPU_CTRL = 0;                       /* default memory map */
    dsb(); isb();
    SCB_VTOR = (uint32_t)(uintptr_t)vectors;
    SCB_CPACR |= 0xFu << 20;
    dsb(); isb();
    DEMCR |= 1u << 24;                  /* TRCENA */
    DWT_LAR = 0xC5ACCE55;
    DWT_CYCCNT = 0;
    DWT_CTRL |= 1;
    /* Peripheral clock gates for the RAMs we use. */
    RCC_AHB2ENR |= 3u << 29;            /* AHB SRAM1/2 */
    RCC_AHB4ENR |= 1u << 29;            /* SRD SRAM */
    (void)RCC_AHB4ENR;
}

void bench_main(void)
{
    H->magic = RES_MAGIC;
    H->version = RES_VERSION;
    H->status = ST_RUNNING;
    H->progress = 0;
    H->nentries = 0;
    H->build = BUILD_ID;
    H->flags = 0;
    H->nsnap = sizeof(snap_addr) / sizeof(snap_addr[0]);
    for (unsigned i = 0; i < 12; i++) {
        H->fault[i] = 0;
    }
    for (unsigned i = 0; i < H->nsnap && i < NSNAP; i++) {
        H->snap[i] = REG(snap_addr[i]);
    }
    for (int i = 0; i < NMPU; i++) {
        MPU_RNR = i;
        H->mpu[i][0] = MPU_RBAR;
        H->mpu[i][1] = MPU_RASR;
    }
    kick();
    quiesce();
    H->flags |= ospi_mapped() ? 1 : 0;

    copy32(AXI_SRD_SAVE, SRD_BASE, SRD_SIZE);

    set_cfg(CFG_OFF);
    clock_tests();
    core_tests(CFG_OFF);
    mem_tests(CFG_OFF);
    fetch_tests(CFG_OFF);
    dma2d_tests();
    dma1_tests();
    cryp_test();
    irq_tests(CFG_OFF);
    memcpy_test(CFG_OFF);

    set_cfg(CFG_ON);
    core_tests(CFG_ON);
    mem_tests(CFG_ON);
    fetch_tests(CFG_ON);
    irq_tests(CFG_ON);
    memcpy_test(CFG_ON);
    set_cfg(CFG_OFF);

    copy32(SRD_BASE, AXI_SRD_SAVE, SRD_SIZE);
    /* Leave the caches as the firmware had them (a rerun snapshots them). */
    if (H->snap[5] & (1u << 17)) {      /* snap.def index 5 = CCR */
        icache_on();
    }
    if (H->snap[5] & (1u << 16)) {
        dcache_on();
    }
    dsb();
    H->status = ST_DONE;
    dsb();
    for (;;) {
        kick();
    }
}
