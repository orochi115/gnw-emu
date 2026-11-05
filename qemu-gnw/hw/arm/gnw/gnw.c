/*
 * Nintendo Game & Watch (Mario 2020 / Zelda 2021) machine.
 *
 * STM32H7B0VB (Cortex-M7) running the stock firmware from the two dumps:
 *   internal=  internal flash bank 1 image (128 or 256 KiB), at 0x08000000
 *   bank2=     optional internal flash bank 2 image (up to 256 KiB, e.g.
 *              Retro-Go), at 0x08100000; reads as erased (0xff) if absent
 *   bank1-overlay= / bank2-overlay=
 *              files that keep internal flash programming (Retro-Go SD
 *              updates); created from internal= / bank2= if missing
 *   external=  SPI NOR image (1 or 4 MiB), seen through OCTOSPI1/OTFDEC
 *   overlay=   optional writable copy of the SPI NOR that receives the
 *              firmware's save writes (created from external= if missing)
 *   buttons=   bit mask of pressed buttons (see GNW_BTN_*), settable at
 *              run time with qom-set /machine buttons <mask>
 *   wav=       capture SAI1 audio into a WAV file
 *   audio=     play SAI1 on the host speakers (macOS AudioQueue)
 *   realtime=  with -icount shift=N,sleep=off: pace virtual time to the
 *              host clock (see gnw_realtime_tick)
 *   battery=   battery level in percent (default 100), settable at run time
 *   usb-power= USB power connected (charging until full), settable at run time
 *   sd-wiring= Retro-Go SD mod: "spi1" (default) or "ospi" (bit-banged on
 *              the flash pins); the card image is -drive if=sd,format=raw
 *   uid=       96-bit device ID as 24 hex digits (Retro-Go keys its flash
 *              cache index with it)
 *   battery-life-min / charge-time-min
 *              minutes for 100 -> 0 % on battery / 0 -> 100 % on USB
 *              (0 = level stays put); see gnw_battery_tick
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/units.h"
#include "qemu/error-report.h"
#include "qapi/error.h"
#include "qapi/visitor.h"
#include "hw/core/boards.h"
#include "hw/core/clock.h"
#include "hw/core/qdev-clock.h"
#include "hw/core/qdev-properties.h"
#include "hw/arm/armv7m.h"
#include "hw/arm/boot.h"
#include "hw/arm/machines-qom.h"
#include "hw/misc/unimp.h"
#include "system/address-spaces.h"
#include "system/system.h"
#include "system/runstate.h"
#include "system/blockdev.h"
#include "system/block-backend.h"
#include "hw/core/qdev-properties-system.h"
#include "exec/icount.h"
#include "qemu/timer.h"
#include "ui/input.h"
#include "gnw.h"

#define TYPE_GNW_MACHINE MACHINE_TYPE_NAME("gnw-common")
OBJECT_DECLARE_TYPE(GnwMachineState, GnwMachineClass, GNW_MACHINE)

struct GnwMachineClass {
    MachineClass parent_class;
    bool zelda;
};

struct GnwMachineState {
    MachineState parent_obj;

    ARMv7MState armv7m;
    Clock *sysclk;
    Clock *refclk;
    MemoryRegion itcm, dtcm, axi_sram, ahb_sram, srd_sram, bkp_sram;
    MemoryRegion dwt;
    MemoryRegion uid_rom;
    uint32_t dwt_ctrl;
    uint32_t dwt_frozen;        /* CYCCNT while the counter is stopped */
    uint64_t dwt_base;          /* cycles at which CYCCNT was 0 */

    GnwGpioState *gpio;
    GnwOspiState *ospi;
    GnwLtdcState *ltdc;
    GnwDmaState *dma;
    GnwAdcState *adc;
    GnwSpiState *spi1;
    GnwSdState *sd;
    char *sd_wiring;
    char *uid;

    char *internal_path;
    char *bank2_path;
    char *bank1_overlay;
    char *bank2_overlay;
    char *external_path;
    char *overlay_path;
    char *wav_path;
    bool audio;
    bool realtime;
    uint32_t battery;           /* QOM view of level, percent */
    bool usb;
    uint32_t battery_life_min, charge_time_min;
    uint32_t adc_override;      /* debug: raw channel-4 value, 0 = model */
    double level;               /* percent, fractional */
    QEMUTimer *bat_timer;
    QEMUTimer *rt_timer;
    int64_t rt_base_v, rt_base_h;
    uint32_t sample_rate;
    uint32_t buttons;           /* from QOM */
    uint32_t keys;              /* from the keyboard */
    bool power_was_pressed;
    QEMUTimer *stop_timer;
    QemuInputHandlerState *input;
};

/*
 * DWT: only CTRL.CYCCNTENA and CYCCNT, enough for cycle-counting benches
 * (hwtest/).  CYCCNT is virtual time converted at GNW_SYSCLK_HZ, i.e. the
 * clock the emulator assumes; with -icount shift=2 every instruction counts
 * 4 ns = 1.12 cycles.  NUMCOMP reads 4 as on the real core.
 */
static uint64_t gnw_dwt_cycles(void)
{
    return muldiv64(qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL), GNW_SYSCLK_HZ,
                    NANOSECONDS_PER_SECOND);
}

static uint32_t gnw_dwt_cyccnt(GnwMachineState *m)
{
    return (m->dwt_ctrl & 1) ? (uint32_t)(gnw_dwt_cycles() - m->dwt_base)
                             : m->dwt_frozen;
}

static uint64_t gnw_dwt_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwMachineState *m = opaque;

    switch (addr) {
    case 0x000:
        return 0x40000000 | m->dwt_ctrl;
    case 0x004:
        return gnw_dwt_cyccnt(m);
    default:
        return 0;
    }
}

static void gnw_dwt_write(void *opaque, hwaddr addr, uint64_t val,
                          unsigned size)
{
    GnwMachineState *m = opaque;

    switch (addr) {
    case 0x000:
        if ((val & 1) && !(m->dwt_ctrl & 1)) {
            m->dwt_base = gnw_dwt_cycles() - m->dwt_frozen;
        } else if (!(val & 1) && (m->dwt_ctrl & 1)) {
            m->dwt_frozen = gnw_dwt_cyccnt(m);
        }
        m->dwt_ctrl = val & 1;
        break;
    case 0x004:
        m->dwt_frozen = val;
        m->dwt_base = gnw_dwt_cycles() - (uint32_t)val;
        break;
    default:
        break;
    }
}

static const MemoryRegionOps gnw_dwt_ops = {
    .read = gnw_dwt_read,
    .write = gnw_dwt_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

/*
 * Real-time pacing for interactive use.
 *
 * Without icount, QEMU fires virtual timers from the main loop as host
 * time passes.  When the loop runs late, periodic timers catch up with a
 * burst of expiries in one pass and the NVIC merges them: SysTick lost a
 * third of its interrupts under Retro-Go, whose frame pacing (HAL_GetTick)
 * then skipped audio half-buffers.  -icount shift=N,sleep=off fires every
 * timer at its exact instruction count instead, but runs as fast as the
 * host allows (and QEMU refuses align=on with sleep=off).
 *
 * This timer restores real-time speed: every millisecond of virtual time
 * it sleeps until the host clock has caught up.  It runs on the main loop
 * with the BQL held, so the vCPU waits too.  After a VM stop, or if the
 * host falls behind by more than 50 ms, the reference point is reset
 * rather than running fast to catch up.
 */
#define RT_SLICE_NS     (1 * SCALE_MS)
#define RT_MAX_BEHIND   (50 * SCALE_MS)

static void gnw_realtime_tick(void *opaque)
{
    GnwMachineState *m = opaque;
    int64_t v = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    int64_t h = qemu_clock_get_ns(QEMU_CLOCK_HOST);
    int64_t ahead = (v - m->rt_base_v) - (h - m->rt_base_h);

    if (ahead > 0) {
        g_usleep(ahead / 1000);
    } else if (ahead < -RT_MAX_BEHIND) {
        m->rt_base_v = v;
        m->rt_base_h = h;
    }
    timer_mod(m->rt_timer, v + RT_SLICE_NS);
}

static void gnw_realtime_vmstate(void *opaque, bool running, RunState state)
{
    GnwMachineState *m = opaque;

    if (running) {
        m->rt_base_v = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
        m->rt_base_h = qemu_clock_get_ns(QEMU_CLOCK_HOST);
    }
}

static void gnw_realtime_start(GnwMachineState *m)
{
    if (!icount_enabled()) {
        warn_report("gnw: realtime=on needs -icount shift=N,sleep=off; "
                    "ignored");
        return;
    }
    m->rt_timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, gnw_realtime_tick, m);
    m->rt_base_v = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    m->rt_base_h = qemu_clock_get_ns(QEMU_CLOCK_HOST);
    timer_mod(m->rt_timer, m->rt_base_v + RT_SLICE_NS);
    qemu_add_vm_change_state_handler(gnw_realtime_vmstate, m);
}

/*
 * Battery and charger (BQ24072).
 *
 * The cell voltage reaches ADC12_INP4 (PC4) through a divider.  Retro-Go
 * reads ADC1 channel 4 with a 1.5-cycle sample and maps 11000 -> 0 %,
 * 13000 -> 100 % (Core/Src/bq24072.c).  The stock firmware samples the
 * same pin on ADC2 for 810.5 cycles and sees ~3.3x more (see gnw_adc.c):
 * it shows four bars from ~43000, one red bar below ~39000 and powers off
 * below ~36740, i.e. below about 5 % on this scale.  The level property
 * uses Retro-Go's scale, so Retro-Go shows exactly the configured percent.
 * The charger reports on two open-drain, active-low pins:
 *   PA2  PGOOD: USB power present
 *   PE7  CHG:   charging (low while charging, released when full)
 * Both are EXTI sources in Retro-Go, so plugging and unplugging is seen at
 * once; the level is polled about once a second (TIM1).
 */
#define BAT_RAW_EMPTY   11000   /* Retro-Go's 1.5-cycle readings */
#define BAT_RAW_FULL    13000
#define BAT_SHORT_SAMPLE 0.3023 /* 1 - exp(-1.5 / ADC_TAU_CYCLES) */

static void gnw_battery_apply(GnwMachineState *m)
{
    bool charging = m->usb && m->level < 100.0;

    m->level = MIN(MAX(m->level, 0.0), 100.0);
    m->battery = (uint32_t)(m->level + 0.5);
    if (m->adc) {
        double short_raw = BAT_RAW_EMPTY +
                           (BAT_RAW_FULL - BAT_RAW_EMPTY) * m->level / 100.0;

        /* Channel value = settled reading; the ADC applies the sampling. */
        gnw_adc_set_channel(m->adc, 4, m->adc_override ? m->adc_override :
                            MIN(short_raw / BAT_SHORT_SAMPLE, 65535.0));
    }
    if (m->gpio) {
        gnw_gpio_set_external(m->gpio, 0, 2, !m->usb);    /* PA2 PGOOD */
        gnw_gpio_set_external(m->gpio, 4, 7, !charging);  /* PE7 CHG */
    }
}

static void gnw_battery_tick(void *opaque)
{
    GnwMachineState *m = opaque;

    if (m->usb && m->charge_time_min) {
        m->level += 100.0 / (m->charge_time_min * 60.0);
    } else if (!m->usb && m->battery_life_min) {
        m->level -= 100.0 / (m->battery_life_min * 60.0);
    }
    gnw_battery_apply(m);
    timer_mod(m->bat_timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) +
                            NANOSECONDS_PER_SECOND);
}

/* GPIO port/pin of each button (retro-go Core/Inc/main.h). */
static const struct { int port, pin; } button_pins[GNW_BTN_COUNT] = {
    [GNW_BTN_LEFT]   = { 3, 11 },
    [GNW_BTN_UP]     = { 3, 0 },
    [GNW_BTN_RIGHT]  = { 3, 15 },
    [GNW_BTN_DOWN]   = { 3, 14 },
    [GNW_BTN_A]      = { 3, 9 },
    [GNW_BTN_B]      = { 3, 5 },
    [GNW_BTN_TIME]   = { 2, 5 },
    [GNW_BTN_GAME]   = { 2, 1 },
    [GNW_BTN_PAUSE]  = { 2, 13 },
    [GNW_BTN_POWER]  = { 0, 0 },
    [GNW_BTN_START]  = { 2, 11 },
    [GNW_BTN_SELECT] = { 2, 12 },
};

static const int button_keys[GNW_BTN_COUNT] = {
    [GNW_BTN_LEFT]   = Q_KEY_CODE_LEFT,
    [GNW_BTN_UP]     = Q_KEY_CODE_UP,
    [GNW_BTN_RIGHT]  = Q_KEY_CODE_RIGHT,
    [GNW_BTN_DOWN]   = Q_KEY_CODE_DOWN,
    [GNW_BTN_A]      = Q_KEY_CODE_X,
    [GNW_BTN_B]      = Q_KEY_CODE_Z,
    [GNW_BTN_TIME]   = Q_KEY_CODE_T,
    [GNW_BTN_GAME]   = Q_KEY_CODE_G,
    [GNW_BTN_PAUSE]  = Q_KEY_CODE_P,
    [GNW_BTN_POWER]  = Q_KEY_CODE_O,
    [GNW_BTN_START]  = Q_KEY_CODE_RET,
    [GNW_BTN_SELECT] = Q_KEY_CODE_TAB,
};

static void gnw_apply_buttons(GnwMachineState *m)
{
    uint32_t pressed = m->buttons | m->keys;
    bool power = pressed & (1 << GNW_BTN_POWER);

    if (!m->gpio) {
        return;
    }
    if (power && !m->power_was_pressed && gnw_pwr_standby_armed()) {
        /* Wake from standby: the SoC comes back up through reset. */
        qemu_system_reset_request(SHUTDOWN_CAUSE_GUEST_RESET);
    }
    m->power_was_pressed = power;
    for (int i = 0; i < GNW_BTN_COUNT; i++) {
        /* Buttons pull the pin to ground. */
        gnw_gpio_set_external(m->gpio, button_pins[i].port,
                              button_pins[i].pin, !(pressed & (1 << i)));
    }
}

static void gnw_key_event(DeviceState *dev, QemuConsole *src,
                          QemuInputEvent *evt)
{
    GnwMachineState *m = GNW_MACHINE(qdev_get_machine());
    int qcode = qemu_input_linux_to_qcode(evt->key.key);

    /* Battery shortcuts: '-' / '=' change the level by 10 %, C toggles USB. */
    if (evt->key.down && (qcode == Q_KEY_CODE_MINUS ||
                          qcode == Q_KEY_CODE_EQUAL || qcode == Q_KEY_CODE_C)) {
        if (qcode == Q_KEY_CODE_C) {
            m->usb = !m->usb;
        } else {
            m->level += qcode == Q_KEY_CODE_EQUAL ? 10 : -10;
        }
        gnw_battery_apply(m);
        info_report("gnw: battery %u%%, USB %s", m->battery,
                    m->usb ? "connected" : "disconnected");
        return;
    }

    for (int i = 0; i < GNW_BTN_COUNT; i++) {
        if (button_keys[i] == qcode) {
            m->keys = deposit32(m->keys, i, 1, evt->key.down);
            gnw_apply_buttons(m);
        }
    }
}

static const QemuInputHandler gnw_input_handler = {
    .name = "Game & Watch buttons",
    .mask = INPUT_EVENT_MASK_KEY,
    .event = gnw_key_event,
};

static void *load_file(const char *what, const char *path, size_t *len)
{
    gchar *data;
    gsize size;
    GError *err = NULL;

    if (!path) {
        error_report("gnw: %s= image is required", what);
        exit(1);
    }
    if (!g_file_get_contents(path, &data, &size, &err)) {
        error_report("gnw: cannot read %s: %s", path, err->message);
        exit(1);
    }
    *len = size;
    return data;
}

static void ram_at(MemoryRegion *mr, const char *name, hwaddr base,
                   uint64_t size)
{
    memory_region_init_ram(mr, NULL, name, size, &error_fatal);
    memory_region_add_subregion(get_system_memory(), base, mr);
}

static SysBusDevice *map_dev(DeviceState *dev, const hwaddr *bases, int n)
{
    SysBusDevice *sbd = SYS_BUS_DEVICE(dev);

    sysbus_realize_and_unref(sbd, &error_fatal);
    for (int i = 0; i < n; i++) {
        sysbus_mmio_map(sbd, i, bases[i]);
    }
    return sbd;
}

static void gnw_init(MachineState *machine)
{
    GnwMachineState *m = GNW_MACHINE(machine);
    MemoryRegion *sysmem = get_system_memory();
    DeviceState *armv7m, *dev;
    SysBusDevice *sbd;
    GnwRegs *rcc;
    uint8_t *internal, *external;
    size_t int_len, ext_len;

#define NVIC(n) qdev_get_gpio_in(armv7m, n)

    /* Images */
    internal = load_file("internal", m->internal_path, &int_len);
    if (m->overlay_path && g_file_test(m->overlay_path, G_FILE_TEST_EXISTS)) {
        external = load_file("overlay", m->overlay_path, &ext_len);
    } else {
        external = load_file("external", m->external_path, &ext_len);
        if (m->overlay_path &&
            !g_file_set_contents(m->overlay_path, (gchar *)external, ext_len,
                                 NULL)) {
            error_report("gnw: cannot create overlay %s", m->overlay_path);
            exit(1);
        }
    }

    /* Memory */
    ram_at(&m->itcm, "itcm", 0x00000000, 64 * KiB);
    /*
     * Flash banks and the FLASH interface.  Bank 2 is undocumented on the
     * H7B0 but present (256 KiB); it reads as erased unless bank2= is set.
     */
    dev = qdev_new(TYPE_GNW_FLASH);
    {
        GnwFlashState *fl = GNW_FLASH(dev);
        uint8_t *b2 = NULL;
        size_t b2_len = 0;

        if (m->bank2_path) {
            b2 = load_file("bank2", m->bank2_path, &b2_len);
            if (b2_len > 256 * KiB) {
                error_report("gnw: bank2 image larger than 256 KiB");
                exit(1);
            }
        }
        gnw_flash_load(fl, 0, internal, int_len,
                       MAX(pow2ceil(int_len), 128 * KiB), m->bank1_overlay);
        gnw_flash_load(fl, 1, b2, b2_len, 256 * KiB, m->bank2_overlay);
        g_free(b2);
    }
    map_dev(dev, (hwaddr[]){ 0x52002000, 0x08000000, 0x08100000 }, 3);
    ram_at(&m->dtcm, "dtcm", 0x20000000, 128 * KiB);
    ram_at(&m->axi_sram, "axi-sram", 0x24000000, 1 * MiB);
    ram_at(&m->ahb_sram, "ahb-sram", 0x30000000, 128 * KiB);
    ram_at(&m->srd_sram, "srd-sram", 0x38000000, 32 * KiB);
    ram_at(&m->bkp_sram, "bkp-sram", 0x38800000, 4 * KiB);

    /* CPU */
    m->sysclk = clock_new(OBJECT(machine), "SYSCLK");
    clock_set_hz(m->sysclk, GNW_SYSCLK_HZ);
    m->refclk = clock_new(OBJECT(machine), "REFCLK");
    clock_set_hz(m->refclk, GNW_SYSCLK_HZ / 8);

    object_initialize_child(OBJECT(machine), "armv7m", &m->armv7m,
                            TYPE_ARMV7M);
    armv7m = DEVICE(&m->armv7m);
    qdev_prop_set_uint32(armv7m, "num-irq", GNW_IRQ_NUM);
    qdev_prop_set_uint8(armv7m, "num-prio-bits", 4);
    qdev_prop_set_string(armv7m, "cpu-type", ARM_CPU_TYPE_NAME("cortex-m7"));
    qdev_prop_set_uint32(armv7m, "init-nsvtor", 0x08000000);
    qdev_connect_clock_in(armv7m, "cpuclk", m->sysclk);
    qdev_connect_clock_in(armv7m, "refclk", m->refclk);
    object_property_set_link(OBJECT(armv7m), "memory", OBJECT(sysmem),
                             &error_abort);
    sysbus_realize(SYS_BUS_DEVICE(armv7m), &error_fatal);
    memory_region_init_io(&m->dwt, OBJECT(machine), &gnw_dwt_ops, m, "dwt",
                          0x1000);
    memory_region_add_subregion_overlap(&m->armv7m.container, 0xe0001000,
                                        &m->dwt, 0);

    /* Anything not modelled below logs with -d unimp and reads as zero. */
    create_unimplemented_device("periph-apb-ahb", 0x40000000, 0x20000000);

    rcc = gnw_regs_create_stubs();

    /* GPIO, EXTI, SYSCFG */
    dev = qdev_new(TYPE_GNW_GPIO);
    m->gpio = GNW_GPIO(dev);
    sbd = map_dev(dev, (hwaddr[]){ 0x58020000, 0x58000000, 0x58000400 }, 3);
    for (int i = 0; i < 5; i++) {
        sysbus_connect_irq(sbd, i, NVIC(GNW_IRQ_EXTI0 + i));
    }
    sysbus_connect_irq(sbd, 5, NVIC(GNW_IRQ_EXTI9_5));
    sysbus_connect_irq(sbd, 6, NVIC(GNW_IRQ_EXTI15_10));
    gnw_apply_buttons(m);
    m->input = qemu_input_handler_register(dev, &gnw_input_handler);

    /* OCTOSPI1 + OTFDEC1 + flash window */
    dev = qdev_new(TYPE_GNW_OSPI);
    m->ospi = GNW_OSPI(dev);
    gnw_ospi_load(m->ospi, external, ext_len, m->overlay_path);
    sbd = map_dev(dev, (hwaddr[]){ 0x52005000, 0x5200b800, 0x90000000 }, 3);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_OCTOSPI1));

    /* LTDC + DMA2D */
    dev = qdev_new(TYPE_GNW_LTDC);
    m->ltdc = GNW_LTDC(dev);
    sbd = map_dev(dev, (hwaddr[]){ 0x50001000, 0x52001000 }, 2);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_LTDC));
    sysbus_connect_irq(sbd, 1, NVIC(GNW_IRQ_DMA2D));

    /* DMA1, DMA2, DMAMUX1, SAI1 */
    dev = qdev_new(TYPE_GNW_DMA);
    m->dma = GNW_DMA(dev);
    m->dma->rcc = rcc;
    qdev_prop_set_uint32(dev, "sample-rate", m->sample_rate);
    if (m->wav_path) {
        qdev_prop_set_string(dev, "wav", m->wav_path);
    }
    qdev_prop_set_bit(dev, "playback", m->audio);
    sbd = map_dev(dev, (hwaddr[]){ 0x40020000, 0x40020400, 0x40020800,
                                   0x40015800 }, 4);
    for (int i = 0; i < 8; i++) {
        static const int dma1[8] = { 11, 12, 13, 14, 15, 16, 17, 47 };
        static const int dma2[8] = { 56, 57, 58, 59, 60, 68, 69, 70 };
        sysbus_connect_irq(sbd, i, NVIC(dma1[i]));
        sysbus_connect_irq(sbd, 8 + i, NVIC(dma2[i]));
    }

    /* Timers */
    {
        static const struct { hwaddr base; int irq; bool wide; } tims[] = {
            { 0x40010000, GNW_IRQ_TIM1_UP, false },    /* Retro-Go: 1 Hz poll */
            { 0x40000000, GNW_IRQ_TIM2, true },
            { 0x40000400, GNW_IRQ_TIM3, false },
            { 0x40000800, GNW_IRQ_TIM4, false },
            { 0x40000c00, GNW_IRQ_TIM5, true },
            { 0x40001000, GNW_IRQ_TIM6, false },
            { 0x40001400, GNW_IRQ_TIM7, false },
            { 0x40014000, GNW_IRQ_TIM15, false },
            { 0x40014400, GNW_IRQ_TIM16, false },
            { 0x40014800, GNW_IRQ_TIM17, false },
        };
        for (int i = 0; i < ARRAY_SIZE(tims); i++) {
            dev = qdev_new(TYPE_GNW_TIM);
            qdev_prop_set_uint32(dev, "width-mask",
                                 tims[i].wide ? 0xffffffff : 0xffff);
            sbd = map_dev(dev, &tims[i].base, 1);
            sysbus_connect_irq(sbd, 0, NVIC(tims[i].irq));
        }
    }

    /* CRYP (AES-GCM for the save slots) */
    sbd = map_dev(qdev_new("gnw-cryp"), (hwaddr[]){ 0x48021000 }, 1);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_CRYP));

    /* ADC1/ADC2 (battery on channel 4) */
    dev = qdev_new(TYPE_GNW_ADC);
    m->adc = (GnwAdcState *)dev;
    sbd = map_dev(dev, (hwaddr[]){ 0x40022000 }, 1);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_ADC));
    m->level = m->battery;
    gnw_battery_apply(m);
    m->bat_timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, gnw_battery_tick, m);
    timer_mod(m->bat_timer, NANOSECONDS_PER_SECOND);

    /* JPEG codec (Retro-Go cover flow; polled, no IRQ needed) */
    map_dev(qdev_new(TYPE_GNW_JPEG), (hwaddr[]){ 0x52003000 }, 1);

    /* RTC + TAMP */
    dev = qdev_new(TYPE_GNW_RTC);
    sbd = map_dev(dev, (hwaddr[]){ 0x58004000, 0x58004400 }, 2);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_RTC_WKUP));
    sysbus_connect_irq(sbd, 1, NVIC(GNW_IRQ_RTC_ALARM));

    /* SPI1 + microSD card (Retro-Go SD mod) */
    dev = qdev_new(TYPE_GNW_SPI);
    m->spi1 = GNW_SPI(dev);
    sbd = map_dev(dev, (hwaddr[]){ 0x40013000 }, 1);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_SPI1));
    gnw_spi_connect_dma(m->spi1, m->dma, 37, 38);
    dev = qdev_new(TYPE_GNW_SDCARD);
    m->sd = GNW_SDCARD(dev);
    m->sd->gpio = m->gpio;
    {
        DriveInfo *dinfo = drive_get(IF_SD, 0, 0);
        bool ospi = false;

        if (m->sd_wiring && !strcmp(m->sd_wiring, "ospi")) {
            ospi = true;
        } else if (m->sd_wiring && strcmp(m->sd_wiring, "spi1")) {
            error_report("gnw: sd-wiring must be spi1 or ospi");
            exit(1);
        }
        if (dinfo) {
            qdev_prop_set_drive_err(dev, "drive", blk_by_legacy_dinfo(dinfo),
                                    &error_fatal);
        }
        qdev_prop_set_bit(dev, "ospi-wiring", ospi);
        qdev_prop_set_bit(dev, "trace", getenv("GNW_SD_TRACE") != NULL);
    }
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    gnw_spi_attach(m->spi1, gnw_sdcard_spi_xfer, m->sd);
    {
        static const struct { int port, pin; const char *in; int n; } w[] = {
            { 0, 15, "vcc", 0 },        /* PA15 card power */
            { 1, 9, "cs", 0 },          /* PB9 CS */
            { 1, 2, "bitbang", 0 },     /* PB2 OSPI CLK */
            { 1, 1, "bitbang", 1 },     /* PB1 OSPI IO0 */
            { 4, 11, "bitbang", 2 },    /* PE11 OSPI nCS */
        };
        for (int i = 0; i < ARRAY_SIZE(w); i++) {
            qdev_connect_gpio_out_named(DEVICE(m->gpio), "pin",
                                        GNW_PIN(w[i].port, w[i].pin),
                                        qdev_get_gpio_in_named(dev, w[i].in,
                                                               w[i].n));
        }
    }

    /* Device electronic signature: UID, flash size (KiB), package. */
    memory_region_init_rom(&m->uid_rom, NULL, "uid", 0x100, &error_fatal);
    {
        uint8_t *p = memory_region_get_ram_ptr(&m->uid_rom);
        uint32_t w[3] = { 0x00470031, 0x3133510b, 0x34313438 };

        memset(p, 0xff, 0x100);
        if (m->uid) {
            if (strlen(m->uid) != 24 ||
                sscanf(m->uid, "%8x%8x%8x", &w[2], &w[1], &w[0]) != 3) {
                error_report("gnw: uid= needs 24 hex digits");
                exit(1);
            }
        }
        for (int i = 0; i < 3; i++) {
            stl_le_p(p + 4 * i, w[i]);
        }
        stw_le_p(p + 0x0c, 128);
        stw_le_p(p + 0x0e, 0x0001);
    }
    memory_region_add_subregion(sysmem, 0x08fff800, &m->uid_rom);

    g_free(internal);
    g_free(external);

    if (m->realtime) {
        gnw_realtime_start(m);
    }
    armv7m_load_kernel(ARM_CPU(first_cpu), NULL, 0, 0);
#undef NVIC
}

/* ------------------------------------------------------------------ */
/* Properties                                                           */

#define STR_PROP(field, name)                                              \
    static char *gnw_get_##field(Object *obj, Error **errp)                \
    {                                                                      \
        return g_strdup(GNW_MACHINE(obj)->field);                          \
    }                                                                      \
    static void gnw_set_##field(Object *obj, const char *v, Error **errp)  \
    {                                                                      \
        GnwMachineState *m = GNW_MACHINE(obj);                             \
        g_free(m->field);                                                  \
        m->field = g_strdup(v);                                            \
    }

STR_PROP(internal_path, "internal")
STR_PROP(bank2_path, "bank2")
STR_PROP(external_path, "external")
STR_PROP(overlay_path, "overlay")
STR_PROP(wav_path, "wav")
STR_PROP(sd_wiring, "sd-wiring")
STR_PROP(uid, "uid")
STR_PROP(bank1_overlay, "bank1-overlay")
STR_PROP(bank2_overlay, "bank2-overlay")

static void gnw_get_battery(Object *obj, Visitor *v, const char *name,
                            void *opaque, Error **errp)
{
    visit_type_uint32(v, name, &GNW_MACHINE(obj)->battery, errp);
}

static void gnw_set_battery(Object *obj, Visitor *v, const char *name,
                            void *opaque, Error **errp)
{
    GnwMachineState *m = GNW_MACHINE(obj);
    uint32_t pct;

    if (!visit_type_uint32(v, name, &pct, errp)) {
        return;
    }
    if (pct > 100) {
        error_setg(errp, "battery must be 0..100");
        return;
    }
    m->battery = pct;
    m->level = pct;
    gnw_battery_apply(m);
}

static bool gnw_get_usb(Object *obj, Error **errp)
{
    return GNW_MACHINE(obj)->usb;
}

static void gnw_set_usb(Object *obj, bool v, Error **errp)
{
    GnwMachineState *m = GNW_MACHINE(obj);

    m->usb = v;
    gnw_battery_apply(m);
}

static void gnw_get_plain_u32(Object *obj, Visitor *v, const char *name,
                              void *opaque, Error **errp)
{
    uint32_t *p = (uint32_t *)((char *)obj + (uintptr_t)opaque);

    visit_type_uint32(v, name, p, errp);
}

static void gnw_set_plain_u32(Object *obj, Visitor *v, const char *name,
                              void *opaque, Error **errp)
{
    uint32_t *p = (uint32_t *)((char *)obj + (uintptr_t)opaque);

    visit_type_uint32(v, name, p, errp);
}

static bool gnw_get_realtime(Object *obj, Error **errp)
{
    return GNW_MACHINE(obj)->realtime;
}

static void gnw_set_realtime(Object *obj, bool v, Error **errp)
{
    GNW_MACHINE(obj)->realtime = v;
}

static bool gnw_get_audio(Object *obj, Error **errp)
{
    return GNW_MACHINE(obj)->audio;
}

static void gnw_set_audio(Object *obj, bool v, Error **errp)
{
    GNW_MACHINE(obj)->audio = v;
}

static void gnw_get_u32(Object *obj, Visitor *v, const char *name,
                        void *opaque, Error **errp)
{
    GnwMachineState *m = GNW_MACHINE(obj);
    uint32_t *p = (uint32_t *)((char *)m + (uintptr_t)opaque);

    visit_type_uint32(v, name, p, errp);
}

static void gnw_set_u32(Object *obj, Visitor *v, const char *name,
                        void *opaque, Error **errp)
{
    GnwMachineState *m = GNW_MACHINE(obj);
    uint32_t *p = (uint32_t *)((char *)m + (uintptr_t)opaque);

    if (visit_type_uint32(v, name, p, errp)) {
        gnw_apply_buttons(m);
    }
}

/*
 * Headless stepping: "stop-after-ms" pauses the VM once that much virtual
 * time has passed (a STOP event is sent); "vtime-ns" reads the clock.
 * With -icount ...,sleep=off this gives reproducible runs.
 */
static void gnw_stop_timer_cb(void *opaque)
{
    qemu_system_vmstop_request_prepare();
    qemu_system_vmstop_request(RUN_STATE_PAUSED);
}

static void gnw_get_vtime(Object *obj, Visitor *v, const char *name,
                          void *opaque, Error **errp)
{
    uint64_t t = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);

    visit_type_uint64(v, name, &t, errp);
}

static void gnw_set_stop_after(Object *obj, Visitor *v, const char *name,
                               void *opaque, Error **errp)
{
    GnwMachineState *m = GNW_MACHINE(obj);
    uint64_t ms;

    if (!visit_type_uint64(v, name, &ms, errp)) {
        return;
    }
    if (!m->stop_timer) {
        m->stop_timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, gnw_stop_timer_cb, m);
    }
    if (ms == 0) {
        timer_del(m->stop_timer);
    } else {
        timer_mod(m->stop_timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) +
                                 ms * SCALE_MS);
    }
}

static void gnw_machine_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);
    static const char * const valid_cpu_types[] = {
        ARM_CPU_TYPE_NAME("cortex-m7"),
        NULL
    };

    mc->init = gnw_init;
    mc->valid_cpu_types = valid_cpu_types;
    mc->default_cpu_type = ARM_CPU_TYPE_NAME("cortex-m7");
    mc->no_floppy = 1;
    mc->no_cdrom = 1;
    mc->no_parallel = 1;
    mc->default_ram_size = 0;

    object_class_property_add_str(oc, "internal", gnw_get_internal_path,
                                  gnw_set_internal_path);
    object_class_property_set_description(oc, "internal",
        "Internal flash image (internal_flash_backup_*.bin)");
    object_class_property_add_str(oc, "bank2", gnw_get_bank2_path,
                                  gnw_set_bank2_path);
    object_class_property_set_description(oc, "bank2",
        "Internal flash bank 2 image, mapped at 0x08100000 (e.g. Retro-Go)");
    object_class_property_add_str(oc, "bank1-overlay", gnw_get_bank1_overlay,
                                  gnw_set_bank1_overlay);
    object_class_property_set_description(oc, "bank1-overlay",
        "Writable copy of bank 1 that keeps flash programming (created from "
        "internal= if missing)");
    object_class_property_add_str(oc, "bank2-overlay", gnw_get_bank2_overlay,
                                  gnw_set_bank2_overlay);
    object_class_property_set_description(oc, "bank2-overlay",
        "Writable copy of bank 2 that keeps flash programming (created from "
        "bank2= if missing)");
    object_class_property_add_str(oc, "external", gnw_get_external_path,
                                  gnw_set_external_path);
    object_class_property_set_description(oc, "external",
        "External SPI flash image (flash_backup_*.bin)");
    object_class_property_add_str(oc, "overlay", gnw_get_overlay_path,
                                  gnw_set_overlay_path);
    object_class_property_set_description(oc, "overlay",
        "Writable copy of the SPI flash for saves (created if missing)");
    object_class_property_add_str(oc, "wav", gnw_get_wav_path,
                                  gnw_set_wav_path);
    object_class_property_set_description(oc, "wav",
        "Write SAI1 audio output to this WAV file");
    object_class_property_add_str(oc, "sd-wiring", gnw_get_sd_wiring,
                                  gnw_set_sd_wiring);
    object_class_property_set_description(oc, "sd-wiring",
        "SD card mod wiring: spi1 (SPI1, default) or ospi (bit-banged on the "
        "external flash pins); card image from -drive if=sd,format=raw");
    object_class_property_add_str(oc, "uid", gnw_get_uid, gnw_set_uid);
    object_class_property_set_description(oc, "uid",
        "96-bit unique device ID, 24 hex digits (most significant first)");
    object_class_property_add(oc, "battery", "uint32", gnw_get_battery,
                              gnw_set_battery, NULL, NULL);
    object_class_property_set_description(oc, "battery",
        "Battery level in percent (0..100, default 100)");
    object_class_property_add_bool(oc, "usb-power", gnw_get_usb,
                                   gnw_set_usb);
    object_class_property_set_description(oc, "usb-power",
        "USB power connected: charges to 100 %, then reports full");
    object_class_property_add(oc, "battery-life-min", "uint32",
                              gnw_get_plain_u32, gnw_set_plain_u32, NULL,
                              (void *)offsetof(GnwMachineState,
                                               battery_life_min));
    object_class_property_set_description(oc, "battery-life-min",
        "Minutes to drain 100 -> 0 % without USB (0 = no drain, default 480)");
    object_class_property_add(oc, "charge-time-min", "uint32",
                              gnw_get_plain_u32, gnw_set_plain_u32, NULL,
                              (void *)offsetof(GnwMachineState,
                                               charge_time_min));
    object_class_property_set_description(oc, "charge-time-min",
        "Minutes to charge 0 -> 100 % on USB (0 = no change, default 180)");
    object_class_property_add(oc, "adc-override", "uint32",
                              gnw_get_plain_u32, gnw_set_plain_u32, NULL,
                              (void *)offsetof(GnwMachineState, adc_override));
    object_class_property_add_bool(oc, "realtime",
        gnw_get_realtime, gnw_set_realtime);
    object_class_property_set_description(oc, "realtime",
        "With -icount shift=N,sleep=off, pace virtual time to the host clock");
    object_class_property_add_bool(oc, "audio",
        gnw_get_audio, gnw_set_audio);
    object_class_property_set_description(oc, "audio",
        "Play SAI1 on the host speakers");
    object_class_property_add(oc, "buttons", "uint32", gnw_get_u32,
                              gnw_set_u32, NULL,
                              (void *)offsetof(GnwMachineState, buttons));
    object_class_property_set_description(oc, "buttons",
        "Pressed buttons: bit0 left, 1 up, 2 right, 3 down, 4 A, 5 B, "
        "6 time, 7 game, 8 pause, 9 power, 10 start, 11 select");
    object_class_property_add(oc, "sample-rate", "uint32", gnw_get_u32,
                              gnw_set_u32, NULL,
                              (void *)offsetof(GnwMachineState, sample_rate));
    object_class_property_set_description(oc, "sample-rate",
        "Override the SAI1 frame rate (0 = derive from RCC/SAI)");
    object_class_property_add(oc, "vtime-ns", "uint64", gnw_get_vtime,
                              NULL, NULL, NULL);
    object_class_property_add(oc, "stop-after-ms", "uint64", NULL,
                              gnw_set_stop_after, NULL, NULL);
    object_class_property_set_description(oc, "stop-after-ms",
        "Pause the VM after this many ms of virtual time");
}

static void gnw_machine_instance_init(Object *obj)
{
    GnwMachineState *m = GNW_MACHINE(obj);

    m->battery = 100;
    m->battery_life_min = 480;      /* ~8 h of play */
    m->charge_time_min = 180;       /* ~3 h on USB */
}

static void gnw_zelda_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);

    mc->desc = "Nintendo Game & Watch: The Legend of Zelda (STM32H7B0)";
    GNW_MACHINE_CLASS(oc)->zelda = true;
}

static void gnw_mario_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);

    mc->desc = "Nintendo Game & Watch: Super Mario Bros. (STM32H7B0)";
}

static const TypeInfo gnw_machine_types[] = {
    {
        .name = TYPE_GNW_MACHINE,
        .parent = TYPE_MACHINE,
        .abstract = true,
        .instance_size = sizeof(GnwMachineState),
        .class_size = sizeof(GnwMachineClass),
        .instance_init = gnw_machine_instance_init,
        .class_init = gnw_machine_class_init,
    }, {
        .name = MACHINE_TYPE_NAME("gnw-zelda"),
        .parent = TYPE_GNW_MACHINE,
        .interfaces = arm_machine_interfaces,
        .class_init = gnw_zelda_class_init,
    }, {
        .name = MACHINE_TYPE_NAME("gnw-mario"),
        .parent = TYPE_GNW_MACHINE,
        .interfaces = arm_machine_interfaces,
        .class_init = gnw_mario_class_init,
    },
};

DEFINE_TYPES(gnw_machine_types)
