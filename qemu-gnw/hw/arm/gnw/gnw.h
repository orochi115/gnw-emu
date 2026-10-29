/*
 * Nintendo Game & Watch (Mario 2020 / Zelda 2021) machine, STM32H7B0 based.
 *
 * Shared declarations for the board and its peripheral models.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#ifndef HW_ARM_GNW_H
#define HW_ARM_GNW_H

#include "hw/core/sysbus.h"
#include "qom/object.h"
#include "ui/console.h"
#include "crypto/aes.h"
#include <pthread.h>

/* CPU clock the stock firmware programs (PLL1 280 MHz). */
#define GNW_SYSCLK_HZ       280000000ULL
#define GNW_TIMCLK_HZ       280000000ULL

/* NVIC lines used by the models (RM0455 vector table). */
#define GNW_IRQ_RTC_WKUP    3
#define GNW_IRQ_EXTI0       6
#define GNW_IRQ_EXTI9_5     23
#define GNW_IRQ_EXTI15_10   40
#define GNW_IRQ_RTC_ALARM   41
#define GNW_IRQ_TIM2        28
#define GNW_IRQ_TIM3        29
#define GNW_IRQ_TIM4        30
#define GNW_IRQ_TIM5        50
#define GNW_IRQ_TIM6        54
#define GNW_IRQ_TIM7        55
#define GNW_IRQ_TIM15       116
#define GNW_IRQ_TIM16       117
#define GNW_IRQ_TIM17       118
#define GNW_IRQ_CRYP        79
#define GNW_IRQ_SAI1        87
#define GNW_IRQ_LTDC        88
#define GNW_IRQ_DMA2D       90
#define GNW_IRQ_OCTOSPI1    92
#define GNW_IRQ_NUM         160

/* Button bit order matches retro-go's buttons_get(). */
enum {
    GNW_BTN_LEFT, GNW_BTN_UP, GNW_BTN_RIGHT, GNW_BTN_DOWN,
    GNW_BTN_A, GNW_BTN_B, GNW_BTN_TIME, GNW_BTN_GAME,
    GNW_BTN_PAUSE, GNW_BTN_POWER, GNW_BTN_START, GNW_BTN_SELECT,
    GNW_BTN_COUNT
};

/* ------------------------------------------------------------------ */
/* Generic register file: read back what was written, with hooks.      */

#define TYPE_GNW_REGS "gnw-regs"
OBJECT_DECLARE_SIMPLE_TYPE(GnwRegs, GNW_REGS)

#define GNW_REGS_MAX 0x1000

typedef uint32_t (*GnwRegsReadFn)(GnwRegs *s, hwaddr off, uint32_t val);
typedef void (*GnwRegsWriteFn)(GnwRegs *s, hwaddr off, uint32_t old,
                               uint32_t val);

struct GnwRegs {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    char *name;
    uint32_t size;
    uint32_t regs[GNW_REGS_MAX / 4];
    uint8_t seen[GNW_REGS_MAX / 4];
    GnwRegsReadFn read_fn;
    GnwRegsWriteFn write_fn;
    void (*reset_fn)(GnwRegs *s);
    qemu_irq irq;
    void *opaque;
};

GnwRegs *gnw_regs_create(const char *name, hwaddr base, uint32_t size,
                         GnwRegsReadFn rfn, GnwRegsWriteFn wfn,
                         void (*reset_fn)(GnwRegs *s));
GnwRegs *gnw_regs_create_stubs(void);
bool gnw_pwr_standby_armed(void);
extern GnwRegs *gnw_pwr;

/* ------------------------------------------------------------------ */
/* GPIO A..K + EXTI + SYSCFG                                            */

#define TYPE_GNW_GPIO "gnw-gpio"
OBJECT_DECLARE_SIMPLE_TYPE(GnwGpioState, GNW_GPIO)

#define GNW_GPIO_PORTS 11

typedef struct GnwGpioPort {
    uint32_t moder, otyper, ospeedr, pupdr, odr, lckr, afr[2];
    uint16_t ext_mask;   /* pins driven from outside (buttons) */
    uint16_t ext_val;
    uint16_t last_in;
} GnwGpioPort;

struct GnwGpioState {
    SysBusDevice parent_obj;
    MemoryRegion gpio_mmio;
    MemoryRegion exti_mmio;
    MemoryRegion syscfg_mmio;
    GnwGpioPort port[GNW_GPIO_PORTS];
    uint32_t exti[0x100 / 4];
    uint32_t syscfg[0x400 / 4];
    qemu_irq exti_irq[7];   /* EXTI0..4, EXTI9_5, EXTI15_10 */
};

void gnw_gpio_set_external(GnwGpioState *s, int port, int pin, bool level);

/* ------------------------------------------------------------------ */
/* OCTOSPI1 + OTFDEC1 + external NOR flash                              */

#define TYPE_GNW_OSPI "gnw-ospi"
OBJECT_DECLARE_SIMPLE_TYPE(GnwOspiState, GNW_OSPI)


struct GnwOspiState {
    SysBusDevice parent_obj;
    MemoryRegion ospi_mmio;
    MemoryRegion otfdec_mmio;
    MemoryRegion xip;           /* 0x90000000 window, decrypted view */

    uint32_t regs[0x400 / 4];
    uint32_t otfdec[0x400 / 4];

    /* flash chip */
    uint8_t *flash;             /* raw (encrypted) contents */
    uint32_t flash_size;
    uint8_t jedec[3];
    uint8_t status, config;
    char *overlay_path;

    /* indirect-mode data phase */
    uint8_t *fifo;
    uint32_t fifo_len, fifo_pos;
    uint8_t *wbuf;
    uint32_t wlen, wexp;

    qemu_irq irq;
};

void gnw_ospi_load(GnwOspiState *s, const uint8_t *data, uint32_t size,
                   const char *overlay);

/* ------------------------------------------------------------------ */
/* LTDC + DMA2D                                                         */

#define TYPE_GNW_LTDC "gnw-ltdc"
OBJECT_DECLARE_SIMPLE_TYPE(GnwLtdcState, GNW_LTDC)

struct GnwLtdcState {
    SysBusDevice parent_obj;
    MemoryRegion ltdc_mmio;
    MemoryRegion dma2d_mmio;
    QemuConsole *con;
    QEMUTimer *frame_timer;
    int64_t frame_start_ns;
    int64_t frame_ns;
    int phase;                  /* 0: before line irq, 1: before vblank */
    uint64_t frame_count;

    uint32_t regs[0x200 / 4];   /* shadow (written) */
    uint32_t active[0x200 / 4]; /* active after reload */
    uint32_t clut[2][256];
    int width, height;

    uint32_t d2d[0x400 / 4];
    uint32_t d2d_fgclut[256], d2d_bgclut[256];

    qemu_irq ltdc_irq;
    qemu_irq dma2d_irq;
};

/* ------------------------------------------------------------------ */
/* DMA1/DMA2 + DMAMUX1 + SAI1                                           */

#define TYPE_GNW_DMA "gnw-dma"
OBJECT_DECLARE_SIMPLE_TYPE(GnwDmaState, GNW_DMA)

typedef struct GnwDmaStream {
    struct GnwDmaState *dma;
    int ctrl, idx;
    QEMUTimer *timer;
    int64_t start_ns;
    int64_t item_ns;
    uint32_t total;
    bool half_done;
} GnwDmaStream;

struct GnwDmaState {
    SysBusDevice parent_obj;
    MemoryRegion dma_mmio[2];
    MemoryRegion dmamux_mmio;
    MemoryRegion sai_mmio;
    uint32_t dma[2][0x100 / 4];
    uint32_t dmamux[0x400 / 4];
    uint32_t sai[0x400 / 4];
    GnwDmaStream stream[2][8];
    qemu_irq irq[2][8];
    qemu_irq sai_irq;
    uint32_t sample_rate;
    GnwRegs *rcc;
    char *wav_path;
    FILE *wav;
    uint32_t wav_bytes;
    bool playback;              /* host speakers via AudioQueue */
    void *aq;                   /* AudioQueueRef */
    int voice_rate;
    int voice_ch;
    uint8_t *pcm;
    unsigned pcm_r;
    unsigned pcm_fill;
    pthread_mutex_t pcm_lock;
};

/* ------------------------------------------------------------------ */
/* General purpose timers and RTC                                       */

#define TYPE_GNW_TIM "gnw-tim"
OBJECT_DECLARE_SIMPLE_TYPE(GnwTimState, GNW_TIM)

struct GnwTimState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    QEMUTimer *timer;
    uint32_t regs[0x400 / 4];
    int64_t start_ns;           /* virtual time when CNT was 0 */
    bool running;
    uint32_t width_mask;
    qemu_irq irq;
};

#define TYPE_GNW_RTC "gnw-rtc"
OBJECT_DECLARE_SIMPLE_TYPE(GnwRtcState, GNW_RTC)

struct GnwRtcState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    MemoryRegion tamp_mmio;
    QEMUTimer *wut_timer;
    QEMUTimer *sec_timer;
    uint32_t regs[0x400 / 4];
    uint32_t tamp[0x400 / 4];
    int rtc_offset;             /* seconds relative to -rtc base */
    bool initialized;
    qemu_irq wkup_irq;
    qemu_irq alarm_irq;
};

#endif
