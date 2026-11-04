/*
 * Nintendo Game & Watch (Mario 2020 / Zelda 2021) machine.
 *
 * STM32H7B0VB (Cortex-M7) running the stock firmware from the two dumps:
 *   internal=  internal flash bank 1 image (128 or 256 KiB), at 0x08000000
 *   bank2=     optional internal flash bank 2 image (up to 256 KiB, e.g.
 *              Retro-Go), at 0x08100000; reads as erased (0xff) if absent
 *   external=  SPI NOR image (1 or 4 MiB), seen through OCTOSPI1/OTFDEC
 *   overlay=   optional writable copy of the SPI NOR that receives the
 *              firmware's save writes (created from external= if missing)
 *   buttons=   bit mask of pressed buttons (see GNW_BTN_*), settable at
 *              run time with qom-set /machine buttons <mask>
 *   wav=       capture SAI1 audio into a WAV file
 *   audio=     play SAI1 on the host speakers (macOS AudioQueue)
 *   realtime=  with -icount shift=N,sleep=off: pace virtual time to the
 *              host clock (see gnw_realtime_tick)
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
    MemoryRegion itcm, flash, flash2, dtcm, axi_sram, ahb_sram, srd_sram, bkp_sram;

    GnwGpioState *gpio;
    GnwOspiState *ospi;
    GnwLtdcState *ltdc;
    GnwDmaState *dma;

    char *internal_path;
    char *bank2_path;
    char *external_path;
    char *overlay_path;
    char *wav_path;
    bool audio;
    bool realtime;
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
    memory_region_init_rom(&m->flash, NULL, "flash",
                           MAX(pow2ceil(int_len), 128 * KiB), &error_fatal);
    memcpy(memory_region_get_ram_ptr(&m->flash), internal, int_len);
    memory_region_add_subregion(sysmem, 0x08000000, &m->flash);
    /* Bank 2: undocumented on the H7B0, but present (256 KiB). */
    memory_region_init_rom(&m->flash2, NULL, "flash-bank2", 256 * KiB,
                           &error_fatal);
    memset(memory_region_get_ram_ptr(&m->flash2), 0xff, 256 * KiB);
    if (m->bank2_path) {
        size_t b2_len;
        uint8_t *b2 = load_file("bank2", m->bank2_path, &b2_len);

        if (b2_len > 256 * KiB) {
            error_report("gnw: bank2 image larger than 256 KiB");
            exit(1);
        }
        memcpy(memory_region_get_ram_ptr(&m->flash2), b2, b2_len);
        g_free(b2);
    }
    memory_region_add_subregion(sysmem, 0x08100000, &m->flash2);
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

    /* JPEG codec (Retro-Go cover flow; polled, no IRQ needed) */
    map_dev(qdev_new(TYPE_GNW_JPEG), (hwaddr[]){ 0x52003000 }, 1);

    /* RTC + TAMP */
    dev = qdev_new(TYPE_GNW_RTC);
    sbd = map_dev(dev, (hwaddr[]){ 0x58004000, 0x58004400 }, 2);
    sysbus_connect_irq(sbd, 0, NVIC(GNW_IRQ_RTC_WKUP));
    sysbus_connect_irq(sbd, 1, NVIC(GNW_IRQ_RTC_ALARM));

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
