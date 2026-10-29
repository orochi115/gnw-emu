/*
 * Game & Watch: general purpose timers (update event only) and the RTC.
 *
 * The RTC keeps calendar time relative to QEMU's -rtc base, so the
 * watch shows host time by default and a fixed time with
 * "-rtc base=...,clock=vm" for reproducible runs.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/timer.h"
#include "qemu/bcd.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "hw/core/qdev-properties.h"
#include "system/rtc.h"
#include "system/system.h"
#include "gnw.h"

/* ------------------------------------------------------------------ */
/* TIMx                                                                 */

#define T_CR1   (0x00 / 4)
#define T_DIER  (0x0c / 4)
#define T_SR    (0x10 / 4)
#define T_EGR   (0x14 / 4)
#define T_CNT   (0x24 / 4)
#define T_PSC   (0x28 / 4)
#define T_ARR   (0x2c / 4)

static int64_t tim_tick_ns(GnwTimState *s)
{
    return MAX(1, (int64_t)(s->regs[T_PSC] + 1) * NANOSECONDS_PER_SECOND /
                  (int64_t)GNW_TIMCLK_HZ);
}

static uint64_t tim_period(GnwTimState *s)
{
    return (uint64_t)(s->regs[T_ARR] & s->width_mask) + 1;
}

static uint32_t tim_count(GnwTimState *s)
{
    int64_t now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);

    if (!s->running) {
        return s->regs[T_CNT];
    }
    return ((now - s->start_ns) / tim_tick_ns(s)) % tim_period(s);
}

static void tim_update_irq(GnwTimState *s)
{
    qemu_set_irq(s->irq, (s->regs[T_SR] & s->regs[T_DIER] & 0xff) != 0);
}

static void tim_schedule(GnwTimState *s)
{
    int64_t now, period_ns, next;

    if (!s->running || !(s->regs[T_DIER] & 1)) {
        timer_del(s->timer);
        return;
    }
    now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    period_ns = MAX(tim_period(s) * tim_tick_ns(s), 10000);
    next = s->start_ns + ((now - s->start_ns) / period_ns + 1) * period_ns;
    timer_mod(s->timer, next);
}

static void tim_tick(void *opaque)
{
    GnwTimState *s = opaque;

    s->regs[T_SR] |= 1;
    tim_update_irq(s);
    if (s->regs[T_CR1] & (1 << 3)) {        /* OPM */
        s->regs[T_CR1] &= ~1;
        s->running = false;
        s->regs[T_CNT] = 0;
        return;
    }
    tim_schedule(s);
}

static uint64_t tim_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwTimState *s = opaque;

    if (addr / 4 == T_CNT) {
        return tim_count(s);
    }
    return s->regs[addr / 4] >> ((addr & 3) * 8);
}

static void tim_write(void *opaque, hwaddr addr, uint64_t value,
                      unsigned size)
{
    GnwTimState *s = opaque;
    int idx = addr / 4;
    int64_t now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);

    switch (idx) {
    case T_SR:
        s->regs[T_SR] &= value;
        break;
    case T_EGR:
        if (value & 1) {
            s->start_ns = now;
            s->regs[T_CNT] = 0;
            if (!(s->regs[T_CR1] & (1 << 2))) {     /* URS */
                s->regs[T_SR] |= 1;
            }
        }
        break;
    case T_CNT:
        s->regs[T_CNT] = value & s->width_mask;
        s->start_ns = now - (int64_t)s->regs[T_CNT] * tim_tick_ns(s);
        break;
    case T_CR1:
        if ((value & 1) && !s->running) {
            s->start_ns = now - (int64_t)s->regs[T_CNT] * tim_tick_ns(s);
            s->running = true;
        } else if (!(value & 1) && s->running) {
            s->regs[T_CNT] = tim_count(s);
            s->running = false;
        }
        s->regs[idx] = value;
        break;
    default:
        s->regs[idx] = value;
        break;
    }
    tim_update_irq(s);
    tim_schedule(s);
}

static const MemoryRegionOps tim_ops = {
    .read = tim_read,
    .write = tim_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 2,
    .valid.max_access_size = 4,
};

static void gnw_tim_reset(DeviceState *dev)
{
    GnwTimState *s = GNW_TIM(dev);

    timer_del(s->timer);
    memset(s->regs, 0, sizeof(s->regs));
    s->regs[T_ARR] = s->width_mask;
    s->running = false;
}

static void gnw_tim_init(Object *obj)
{
    GnwTimState *s = GNW_TIM(obj);

    memory_region_init_io(&s->mmio, obj, &tim_ops, s, "tim", 0x400);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->mmio);
    sysbus_init_irq(SYS_BUS_DEVICE(obj), &s->irq);
    s->timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, tim_tick, s);
}

static const Property gnw_tim_props[] = {
    DEFINE_PROP_UINT32("width-mask", GnwTimState, width_mask, 0xffff),
};

static void gnw_tim_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    device_class_set_legacy_reset(dc, gnw_tim_reset);
    device_class_set_props(dc, gnw_tim_props);
}

/* ------------------------------------------------------------------ */
/* RTC (RM0455 section 47) and TAMP backup registers                    */

#define R_TR      (0x00 / 4)
#define R_DR      (0x04 / 4)
#define R_SSR     (0x08 / 4)
#define R_ICSR    (0x0c / 4)
#define R_PRER    (0x10 / 4)
#define R_WUTR    (0x14 / 4)
#define R_CR      (0x18 / 4)
#define R_ALRMAR  (0x40 / 4)
#define R_ALRMBR  (0x48 / 4)
#define R_SR      (0x50 / 4)
#define R_MISR    (0x54 / 4)
#define R_SCR     (0x5c / 4)

#define ICSR_INIT   (1 << 7)

static void rtc_now(GnwRtcState *s, struct tm *tm)
{
    qemu_get_timedate(tm, s->rtc_offset);
}

static uint32_t tm_to_tr(struct tm *tm)
{
    return (to_bcd(tm->tm_hour) << 16) | (to_bcd(tm->tm_min) << 8) |
           to_bcd(tm->tm_sec);
}

static uint32_t tm_to_dr(struct tm *tm)
{
    int wd = tm->tm_wday ? tm->tm_wday : 7;

    return (to_bcd(tm->tm_year % 100) << 16) | (wd << 13) |
           (to_bcd(tm->tm_mon + 1) << 8) | to_bcd(tm->tm_mday);
}

static void rtc_update_irq(GnwRtcState *s)
{
    uint32_t sr = s->regs[R_SR], cr = s->regs[R_CR];
    bool alarm = ((sr & 1) && (cr & (1 << 12))) ||
                 ((sr & 2) && (cr & (1 << 13)));
    bool wkup = (sr & 4) && (cr & (1 << 14));

    s->regs[R_MISR] = (alarm ? (sr & 3) : 0) | (wkup ? 4 : 0);
    qemu_set_irq(s->alarm_irq, alarm);
    qemu_set_irq(s->wkup_irq, wkup);
}

static bool alarm_match(uint32_t alrm, uint32_t tr, uint32_t dr)
{
    if (!(alrm & (1 << 7)) && (alrm & 0x7f) != (tr & 0x7f)) {
        return false;
    }
    if (!(alrm & (1 << 15)) && ((alrm >> 8) & 0x7f) != ((tr >> 8) & 0x7f)) {
        return false;
    }
    if (!(alrm & (1 << 23)) && ((alrm >> 16) & 0x7f) != ((tr >> 16) & 0x7f)) {
        return false;
    }
    if (!(alrm & (1u << 31))) {
        if (alrm & (1 << 30)) {
            if (((alrm >> 24) & 0xf) != ((dr >> 13) & 7)) {
                return false;
            }
        } else if (((alrm >> 24) & 0x3f) != (dr & 0x3f)) {
            return false;
        }
    }
    return true;
}

static void rtc_second(void *opaque)
{
    GnwRtcState *s = opaque;
    struct tm tm;
    uint32_t tr, dr;

    rtc_now(s, &tm);
    tr = tm_to_tr(&tm);
    dr = tm_to_dr(&tm);
    if ((s->regs[R_CR] & (1 << 8)) && alarm_match(s->regs[R_ALRMAR], tr, dr)) {
        s->regs[R_SR] |= 1;
    }
    if ((s->regs[R_CR] & (1 << 9)) && alarm_match(s->regs[R_ALRMBR], tr, dr)) {
        s->regs[R_SR] |= 2;
    }
    rtc_update_irq(s);
    timer_mod(s->sec_timer, (qemu_clock_get_ns(rtc_clock) /
                             NANOSECONDS_PER_SECOND + 1) *
                            NANOSECONDS_PER_SECOND);
}

static int64_t rtc_wut_period_ns(GnwRtcState *s)
{
    uint32_t sel = s->regs[R_CR] & 7;
    uint64_t wut = s->regs[R_WUTR] & 0xffff;

    if (sel < 4) {
        return (wut + 1) * NANOSECONDS_PER_SECOND / (32768 >> (4 - sel));
    }
    if (sel >= 6) {
        wut += 0x10000;
    }
    return (wut + 1) * NANOSECONDS_PER_SECOND;
}

static void rtc_wut(void *opaque)
{
    GnwRtcState *s = opaque;

    s->regs[R_SR] |= 4;
    rtc_update_irq(s);
    timer_mod(s->wut_timer, qemu_clock_get_ns(rtc_clock) +
                            rtc_wut_period_ns(s));
}

static uint64_t rtc_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwRtcState *s = opaque;
    int idx = addr / 4;
    bool init = s->regs[R_ICSR] & ICSR_INIT;
    struct tm tm;

    switch (idx) {
    case R_TR:
        if (init) {
            return s->regs[R_TR];
        }
        rtc_now(s, &tm);
        return tm_to_tr(&tm);
    case R_DR:
        if (init) {
            return s->regs[R_DR];
        }
        rtc_now(s, &tm);
        return tm_to_dr(&tm);
    case R_SSR: {
        uint32_t ps = s->regs[R_PRER] & 0x7fff;
        int64_t frac = qemu_clock_get_ns(rtc_clock) % NANOSECONDS_PER_SECOND;
        return ps - (frac * (ps + 1) / NANOSECONDS_PER_SECOND);
    }
    case R_ICSR:
        return (s->regs[R_ICSR] & ICSR_INIT) | (init ? (1 << 6) : 0) |
               (1 << 5) | (s->initialized ? (1 << 4) : 0) | 7;
    }
    return s->regs[idx];
}

static void rtc_write(void *opaque, hwaddr addr, uint64_t value,
                      unsigned size)
{
    GnwRtcState *s = opaque;
    int idx = addr / 4;
    uint32_t old = s->regs[idx];

    switch (idx) {
    case R_ICSR:
        s->regs[R_ICSR] = value & ICSR_INIT;
        if ((old & ICSR_INIT) && !(value & ICSR_INIT)) {
            struct tm tm = {
                .tm_sec = from_bcd(s->regs[R_TR] & 0x7f),
                .tm_min = from_bcd((s->regs[R_TR] >> 8) & 0x7f),
                .tm_hour = from_bcd((s->regs[R_TR] >> 16) & 0x3f),
                .tm_mday = from_bcd(s->regs[R_DR] & 0x3f),
                .tm_mon = from_bcd((s->regs[R_DR] >> 8) & 0x1f) - 1,
                .tm_year = from_bcd((s->regs[R_DR] >> 16) & 0xff) + 100,
            };
            s->rtc_offset = qemu_timedate_diff(&tm);
            s->initialized = true;
        } else if (!(old & ICSR_INIT) && (value & ICSR_INIT)) {
            struct tm tm;
            rtc_now(s, &tm);
            s->regs[R_TR] = tm_to_tr(&tm);
            s->regs[R_DR] = tm_to_dr(&tm);
        }
        return;
    case R_SR: case R_MISR: case R_SSR:
        return;
    case R_SCR:
        s->regs[R_SR] &= ~value;
        rtc_update_irq(s);
        return;
    case R_CR:
        s->regs[idx] = value;
        if ((value & (1 << 10)) && !(old & (1 << 10))) {
            timer_mod(s->wut_timer, qemu_clock_get_ns(rtc_clock) +
                                    rtc_wut_period_ns(s));
        } else if (!(value & (1 << 10))) {
            timer_del(s->wut_timer);
        }
        rtc_update_irq(s);
        return;
    }
    s->regs[idx] = value;
}

static const MemoryRegionOps rtc_ops = {
    .read = rtc_read,
    .write = rtc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static uint64_t tamp_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwRtcState *s = opaque;

    return s->tamp[addr / 4];
}

static void tamp_write(void *opaque, hwaddr addr, uint64_t value,
                       unsigned size)
{
    GnwRtcState *s = opaque;

    s->tamp[addr / 4] = value;
}

static const MemoryRegionOps tamp_ops = {
    .read = tamp_read,
    .write = tamp_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gnw_rtc_reset(DeviceState *dev)
{
    GnwRtcState *s = GNW_RTC(dev);

    memset(s->regs, 0, sizeof(s->regs));
    s->regs[R_PRER] = 0x007f00ff;
    s->regs[R_WUTR] = 0xffff;
    timer_del(s->wut_timer);
    rtc_second(s);
}

static void gnw_rtc_init(Object *obj)
{
    GnwRtcState *s = GNW_RTC(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->mmio, obj, &rtc_ops, s, "rtc", 0x400);
    memory_region_init_io(&s->tamp_mmio, obj, &tamp_ops, s, "tamp", 0x400);
    sysbus_init_mmio(sbd, &s->mmio);
    sysbus_init_mmio(sbd, &s->tamp_mmio);
    sysbus_init_irq(sbd, &s->wkup_irq);
    sysbus_init_irq(sbd, &s->alarm_irq);
    s->wut_timer = timer_new_ns(rtc_clock, rtc_wut, s);
    s->sec_timer = timer_new_ns(rtc_clock, rtc_second, s);
    s->initialized = true;
}

static void gnw_rtc_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_rtc_reset);
}

static const TypeInfo gnw_timer_types[] = {
    {
        .name = TYPE_GNW_TIM,
        .parent = TYPE_SYS_BUS_DEVICE,
        .instance_size = sizeof(GnwTimState),
        .instance_init = gnw_tim_init,
        .class_init = gnw_tim_class_init,
    }, {
        .name = TYPE_GNW_RTC,
        .parent = TYPE_SYS_BUS_DEVICE,
        .instance_size = sizeof(GnwRtcState),
        .instance_init = gnw_rtc_init,
        .class_init = gnw_rtc_class_init,
    },
};

DEFINE_TYPES(gnw_timer_types)
