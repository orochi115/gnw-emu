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
#include "migration/vmstate.h"
#include "ui/console.h"
#include "crypto/aes.h"
#include "qemu/audio.h"
#include "qemu/notify.h"

/* CPU clock the stock firmware programs (PLL1 280 MHz). */
#define GNW_SYSCLK_HZ       280000000ULL
#define GNW_TIMCLK_HZ       280000000ULL

/* NVIC lines used by the models (RM0455 vector table). */
#define GNW_IRQ_RTC_WKUP    3
#define GNW_IRQ_EXTI0       6
#define GNW_IRQ_EXTI9_5     23
#define GNW_IRQ_EXTI15_10   40
#define GNW_IRQ_RTC_ALARM   41
#define GNW_IRQ_ADC         18
#define GNW_IRQ_SPI1        35
#define GNW_IRQ_TIM1_UP     25
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
    GByteArray
        *hash_msg; /* in-flight HASH input; NULL on other register files */
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
    /* Pin levels for devices on the board, line = port * 16 + pin. */
    qemu_irq out[GNW_GPIO_PORTS * 16];
    uint16_t last_out[GNW_GPIO_PORTS];
};

#define GNW_PIN(port, pin) ((port) * 16 + (pin))

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
/* DAC1/2                                                              */

/* DAC1/2: immediate and software-triggered conversions for backlight. */
#define TYPE_GNW_DAC "gnw-dac"
OBJECT_DECLARE_SIMPLE_TYPE(GnwDacState, GNW_DAC)

struct GnwDacState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    uint32_t regs[0x400 / 4];
    uint16_t dhr[2], dor[2];
};

uint16_t gnw_dac_output(GnwDacState *s, unsigned channel);

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
    bool rail_3v3, rail_1v8_n;  /* PD4, PD1: the panel shows black when off */
    GnwDacState *backlight_dac; /* DAC1_OUT1 / PA4, representative intensity */
    GnwGpioState *gpio;        /* PA4 GPIO output overrides analog backlight */
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
    bool periph;                /* handshaked with a peripheral model */
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
    bool playback;              /* host speakers via QEMU audio backend */
    bool muted;                 /* host mixer only; guest DMA keeps running */
    AudioBackend *audio_be;
    Notifier audio_exit;
    bool audio_registered;
    SWVoiceOut *voice;
    int voice_rate;
    int voice_ch;
    uint8_t *pcm;
    unsigned pcm_r;
    unsigned pcm_fill;
    /* Called when a stream towards a handshaking peripheral is enabled. */
    void (*periph_kick)(void *opaque);
    void *periph_opaque;
};

/*
 * Peripheral flow control for DMAMUX1 request line `req` (RM0455 table
 * 123, e.g. SPI1 RX 37, TX 38): move one item between the peripheral and
 * the enabled stream that serves the request.  Returns false when no
 * stream is ready, so the peripheral falls back to its registers.
 */
bool gnw_dma_req_active(GnwDmaState *s, int req);
void gnw_dma_set_muted(GnwDmaState *s, bool muted);
bool gnw_dma_req_mem_to_periph(GnwDmaState *s, int req, uint32_t *item);
bool gnw_dma_req_periph_to_mem(GnwDmaState *s, int req, uint32_t item);

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
#define TYPE_GNW_JPEG "gnw-jpeg"
#define TYPE_GNW_ADC "gnw-adc"
typedef struct GnwAdcState GnwAdcState;
/* Set the 16-bit full-scale input of an ADC channel (shared by ADC1/2). */
void gnw_adc_set_channel(GnwAdcState *s, int ch, uint16_t value);
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

/* ------------------------------------------------------------------ */
/* SPI (v2) master, SPI1 for the SD card mod                            */

#define TYPE_GNW_SPI "gnw-spi"
OBJECT_DECLARE_SIMPLE_TYPE(GnwSpiState, GNW_SPI)

#define GNW_SPI_FIFO 16

/* Exchange one byte with the device on the bus. */
typedef uint8_t (*GnwSpiXfer)(void *opaque, uint8_t out);

struct GnwSpiState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    uint32_t regs[0x400 / 4];
    uint32_t sr;                /* sticky status bits */
    uint8_t rx[GNW_SPI_FIFO];
    unsigned rx_head, rx_len;
    bool running;               /* CSTART until EOT */
    uint16_t ctsize;            /* frames left (0: endless) */
    GnwSpiXfer xfer;
    void *xfer_opaque;
    GnwDmaState *dma;
    int req_rx, req_tx;
    qemu_irq irq;
};

void gnw_spi_attach(GnwSpiState *s, GnwSpiXfer fn, void *opaque);
void gnw_spi_connect_dma(GnwSpiState *s, GnwDmaState *dma, int req_rx,
                         int req_tx);

/* ------------------------------------------------------------------ */
/* microSD card (SPI mode) for the Retro-Go SD mod                      */

#define TYPE_GNW_SDCARD "gnw-sdcard"
OBJECT_DECLARE_SIMPLE_TYPE(GnwSdState, GNW_SDCARD)

struct GnwSdState {
    SysBusDevice parent_obj;
    BlockBackend *blk;
    bool ospi_wiring;
    bool trace;                 /* log every command (-D file) */
    bool read_only;
    uint64_t sectors;
    GnwGpioState *gpio;         /* for MISO on PD12 (ospi wiring) */

    bool powered, selected, idle, app;
    int state;
    uint8_t cmd[6];
    int cmd_len;
    uint8_t out[600];
    unsigned out_len, out_pos;
    bool rd_multi, wr_multi;
    uint32_t rd_lba, wr_lba;
    uint8_t wbuf[514];
    unsigned wpos;
    uint64_t reads, writes;

    /* bit-banged wiring */
    bool bb_clk, bb_mosi;
    uint8_t bb_in, bb_out;
    int bit;
};

uint8_t gnw_sdcard_spi_xfer(void *opaque, uint8_t in);

/* ------------------------------------------------------------------ */
/* Embedded flash: both banks + FLASH interface (program/erase)         */

#define TYPE_GNW_FLASH "gnw-flash"
OBJECT_DECLARE_SIMPLE_TYPE(GnwFlashState, GNW_FLASH)

struct GnwFlashState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    MemoryRegion bank[2];
    uint32_t size[2];
    int fd[2];                  /* overlay file, -1 if none */
    uint32_t regs[0x1000 / 4];
    int key_step[2];
    uint8_t wbuf[2][16];
    uint32_t waddr[2];
    uint16_t wmask[2];
};

/* Create bank b (0/1) from an image and/or a persistent overlay file. */
void gnw_flash_load(GnwFlashState *s, int b, const uint8_t *data,
                    size_t len, uint32_t size, const char *overlay);

void gnw_ltdc_restore(GnwLtdcState *s);
bool gnw_ospi_restore(GnwOspiState *s, Error **errp);
bool gnw_flash_restore(GnwFlashState *s, Error **errp);
#endif
