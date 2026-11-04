/*
 * Game & Watch: ADC1/ADC2 (RM0455 section 25), enough for the battery.
 *
 * Both firmwares measure the battery on channel 4 (PC4, ADC12_INP4): the
 * stock firmware polls ADC2 with 1024x oversampling, Retro-Go starts ADC1
 * with HAL_ADC_Start_IT() and reads DR in the EOC interrupt.  A started
 * conversion completes after a few microseconds of virtual time with the
 * value the machine set through gnw_adc_set_channel(); unknown channels
 * read mid-scale.
 *
 * The battery divider has a high source impedance, so the sample-and-hold
 * capacitor does not settle within a short sampling time: on the real
 * board Retro-Go (1.5 cycles) reads about 30 % of what the stock firmware
 * (810.5 cycles) reads from the same pin -- full charge is 13000 in
 * Retro-Go and ~43000 for the stock firmware.  The channel value set by
 * the machine is the settled reading; each conversion scales it by
 * 1 - exp(-cycles / ADC_TAU_CYCLES), with tau fitted to that 30 %.
 *
 * Register subset per ADC: ISR, IER, CR (ADEN/ADDIS/ADSTART/ADSTP/ADCAL),
 * CFGR (RES, CONT), CFGR2 (oversampling), SMPR1/2, SQR1 (first conversion
 * only), DR.  Common registers at 0x300 just store their value.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include <math.h>
#include "qemu/timer.h"
#include "hw/core/irq.h"
#include "hw/core/sysbus.h"
#include "qom/object.h"
#include "gnw.h"

#define R_ISR   (0x00 / 4)
#define R_IER   (0x04 / 4)
#define R_CR    (0x08 / 4)
#define R_CFGR  (0x0c / 4)
#define R_CFGR2 (0x10 / 4)
#define R_SMPR1 (0x14 / 4)
#define R_SQR1  (0x30 / 4)
#define R_DR    (0x40 / 4)

#define ISR_ADRDY   (1 << 0)
#define ISR_EOSMP   (1 << 1)
#define ISR_EOC     (1 << 2)
#define ISR_EOS     (1 << 3)

#define CR_ADEN     (1 << 0)
#define CR_ADDIS    (1 << 1)
#define CR_ADSTART  (1 << 2)
#define CR_ADSTP    (1 << 4)
#define CR_ADCAL    (1u << 31)

#define CONV_NS     (5 * SCALE_US)
#define ADC_TAU_CYCLES  4.17    /* 1.5 cycles -> 30.2 % of the settled value */
#define NCHAN       20

OBJECT_DECLARE_SIMPLE_TYPE(GnwAdcState, GNW_ADC)

typedef struct {
    uint32_t regs[0x100 / 4];
    QEMUTimer *timer;
} GnwAdcUnit;

struct GnwAdcState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    qemu_irq irq;               /* ADC1_2 global interrupt */
    GnwAdcUnit unit[2];
    uint32_t common[0x100 / 4];
    uint16_t chan[NCHAN];       /* 16-bit full-scale value per channel */
};

static void adc_update_irq(GnwAdcState *s)
{
    bool level = false;

    for (int i = 0; i < 2; i++) {
        level |= (s->unit[i].regs[R_ISR] & s->unit[i].regs[R_IER] & 0x7ff) != 0;
    }
    qemu_set_irq(s->irq, level);
}

static uint32_t adc_convert(GnwAdcState *s, GnwAdcUnit *u)
{
    int ch = extract32(u->regs[R_SQR1], 6, 5);
    static const double smp_cycles[8] = {
        1.5, 2.5, 8.5, 16.5, 32.5, 64.5, 387.5, 810.5
    };
    uint32_t smpr = u->regs[R_SMPR1 + (ch >= 10)];
    double cycles = smp_cycles[extract32(smpr, 3 * (ch % 10), 3)];
    uint32_t v = (ch < NCHAN ? s->chan[ch] : 0x8000) *
                 (1.0 - exp(-cycles / ADC_TAU_CYCLES));
    static const int res_bits[8] = { 16, 14, 12, 12, 12, 10, 8, 8 };
    int bits = res_bits[extract32(u->regs[R_CFGR], 2, 3)];
    uint32_t cfgr2 = u->regs[R_CFGR2];
    uint64_t r = v >> (16 - bits);

    if (cfgr2 & 1) {            /* ROVSE: sum of OVSR+1 samples >> OVSS */
        r = (r * (extract32(cfgr2, 16, 10) + 1)) >> extract32(cfgr2, 5, 4);
    }
    return MIN(r, 0xffffffffu);
}

static void adc_finish(GnwAdcState *s, int i)
{
    GnwAdcUnit *u = &s->unit[i];

    if (!(u->regs[R_CR] & CR_ADSTART)) {
        return;
    }
    u->regs[R_DR] = adc_convert(s, u);
    u->regs[R_ISR] |= ISR_EOSMP | ISR_EOC | ISR_EOS;
    if (u->regs[R_CFGR] & (1 << 13)) {          /* CONT */
        timer_mod(u->timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + CONV_NS);
    } else {
        u->regs[R_CR] &= ~CR_ADSTART;
    }
    adc_update_irq(s);
}

static void adc_timer0(void *opaque)
{
    adc_finish(opaque, 0);
}

static void adc_timer1(void *opaque)
{
    adc_finish(opaque, 1);
}

void gnw_adc_set_channel(GnwAdcState *s, int ch, uint16_t value)
{
    if (ch >= 0 && ch < NCHAN) {
        s->chan[ch] = value;
    }
}

static uint64_t gnw_adc_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwAdcState *s = opaque;
    GnwAdcUnit *u;
    uint32_t v;

    if (addr >= 0x300) {
        return s->common[(addr - 0x300) / 4];
    }
    if (addr >= 0x200) {
        return 0;
    }
    u = &s->unit[addr / 0x100];
    v = u->regs[(addr & 0xff) / 4];
    if ((addr & 0xff) / 4 == R_DR) {
        u->regs[R_ISR] &= ~ISR_EOC;             /* reading DR clears EOC */
        adc_update_irq(s);
    }
    return v;
}

static void gnw_adc_write(void *opaque, hwaddr addr, uint64_t value,
                          unsigned size)
{
    GnwAdcState *s = opaque;
    int i = addr / 0x100, idx = (addr & 0xff) / 4;
    GnwAdcUnit *u;

    if (addr >= 0x300) {
        s->common[(addr - 0x300) / 4] = value;
        return;
    }
    if (addr >= 0x200) {
        return;
    }
    u = &s->unit[i];
    switch (idx) {
    case R_ISR:
        u->regs[R_ISR] &= ~value;               /* write 1 to clear */
        break;
    case R_CR:
        u->regs[R_CR] = (u->regs[R_CR] & (CR_ADEN | CR_ADSTART)) |
                        (value & ~(CR_ADEN | CR_ADDIS | CR_ADSTART |
                                   CR_ADSTP | CR_ADCAL));
        if (value & CR_ADDIS) {
            u->regs[R_CR] &= ~(CR_ADEN | CR_ADSTART);
            u->regs[R_ISR] &= ~ISR_ADRDY;
            timer_del(u->timer);
        } else if (value & CR_ADEN) {
            if (!(u->regs[R_CR] & CR_ADEN)) {
                u->regs[R_ISR] |= ISR_ADRDY;
            }
            u->regs[R_CR] |= CR_ADEN;
        }
        if (value & CR_ADSTP) {
            u->regs[R_CR] &= ~CR_ADSTART;
            timer_del(u->timer);
        }
        if ((value & CR_ADSTART) && (u->regs[R_CR] & CR_ADEN) &&
            !(u->regs[R_CR] & CR_ADSTART)) {
            u->regs[R_CR] |= CR_ADSTART;
            timer_mod(u->timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) +
                                CONV_NS);
        }
        /* ADCAL completes at once (bit reads back as 0). */
        break;
    case R_DR:
        break;
    default:
        u->regs[idx] = value;
        break;
    }
    adc_update_irq(s);
}

static const MemoryRegionOps gnw_adc_ops = {
    .read = gnw_adc_read,
    .write = gnw_adc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gnw_adc_reset(DeviceState *dev)
{
    GnwAdcState *s = GNW_ADC(dev);

    for (int i = 0; i < 2; i++) {
        memset(s->unit[i].regs, 0, sizeof(s->unit[i].regs));
        s->unit[i].regs[R_CR] = 1 << 29;        /* DEEPPWD */
        timer_del(s->unit[i].timer);
    }
    memset(s->common, 0, sizeof(s->common));
    adc_update_irq(s);
}

static void gnw_adc_init(Object *obj)
{
    GnwAdcState *s = GNW_ADC(obj);

    memory_region_init_io(&s->mmio, obj, &gnw_adc_ops, s, "adc12", 0x400);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->mmio);
    sysbus_init_irq(SYS_BUS_DEVICE(obj), &s->irq);
    s->unit[0].timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, adc_timer0, s);
    s->unit[1].timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, adc_timer1, s);
    for (int c = 0; c < NCHAN; c++) {
        s->chan[c] = 0x8000;
    }
}

static void gnw_adc_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_adc_reset);
}

static const TypeInfo gnw_adc_info = {
    .name = TYPE_GNW_ADC,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwAdcState),
    .instance_init = gnw_adc_init,
    .class_init = gnw_adc_class_init,
};

static void gnw_adc_register(void)
{
    type_register_static(&gnw_adc_info);
}

type_init(gnw_adc_register)
