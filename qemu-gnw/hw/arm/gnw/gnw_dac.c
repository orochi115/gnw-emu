/*
 * Game & Watch: DAC1/2 backlight control (STM32H7B0).
 *
 * Convert immediately when TEN=0, or on SWTRIG when TSEL=0. Other
 * triggers, DMA, calibration and wave generation are not modelled.
 * DOR holds its last conversion when disabled; the external output is 0.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "gnw.h"

#define D_CR      (0x00 / 4)
#define D_SWTRIGR (0x04 / 4)
#define D_SR      (0x34 / 4)

uint16_t gnw_dac_output(GnwDacState *s, unsigned channel)
{
    return (s->regs[D_CR] & (1u << (channel * 16))) ? s->dor[channel] : 0;
}

static void dac_convert(GnwDacState *s, unsigned channel, bool trigger)
{
    uint32_t cr = s->regs[D_CR] >> (channel * 16);

    if ((cr & 1) && (!(cr & 2) ||
                    (trigger && !(cr & 0x3c)))) {
        s->dor[channel] = s->dhr[channel];
    }
}

/* DHR8, DHR12R and DHR12L are views of the same holding value. */
static uint32_t dac_data_read(GnwDacState *s, unsigned off)
{
    unsigned channel = off >= 0x14;

    if (off <= 0x1c) {
        switch ((off - 8) % 12) {
        case 0: return s->dhr[channel];
        case 4: return s->dhr[channel] << 4;
        case 8: return s->dhr[channel] >> 4;
        }
    }
    switch (off) {
    case 0x20: return s->dhr[0] | (s->dhr[1] << 16);
    case 0x24: return (s->dhr[0] << 4) | (s->dhr[1] << 20);
    case 0x28: return (s->dhr[0] >> 4) | ((s->dhr[1] >> 4) << 8);
    }
    g_assert_not_reached();
}

static uint64_t dac_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwDacState *s = opaque;
    unsigned off = addr & ~3u;
    uint32_t value;

    if (off >= 8 && off <= 0x28) {
        value = dac_data_read(s, off);
    } else if (off == 0x2c || off == 0x30) {
        value = s->dor[(off - 0x2c) / 4];
    } else if (off == 4) {
        value = 0;             /* software triggers self-clear */
    } else {
        value = s->regs[off / 4];
    }
    return value >> ((addr & 3) * 8);
}

static void dac_data_write(GnwDacState *s, unsigned off, uint32_t value,
                           uint32_t mask)
{
    unsigned first = off < 0x14 ? 0 : 1;
    unsigned last = first;
    unsigned align;

    if (off >= 0x20) {
        first = 0;
        last = 1;
        align = (off - 0x20) / 4;
    } else {
        align = ((off - 8) % 12) / 4;
    }
    for (unsigned ch = first; ch <= last; ch++) {
        unsigned shift = off >= 0x20 ? ch * (align == 2 ? 8 : 16) : 0;
        unsigned bits = align == 2 ? 8 : 12;
        uint32_t data;

        shift += align == 1 ? 4 : 0;
        if (!(mask & (MAKE_64BIT_MASK(shift, bits)))) {
            continue;
        }
        data = extract32(value, shift, bits);
        s->dhr[ch] = align == 2 ? data << 4 : data;
        dac_convert(s, ch, false);
    }
}

static void dac_write(void *opaque, hwaddr addr, uint64_t value,
                      unsigned size)
{
    GnwDacState *s = opaque;
    unsigned off = addr & ~3u, shift = (addr & 3) * 8;
    uint32_t mask = MAKE_64BIT_MASK(shift, size * 8);
    uint32_t written = (uint32_t)value << shift;
    uint32_t merged;

    if (off == 0x2c || off == 0x30) {
        return;               /* DOR is read-only */
    }
    if (off == D_SWTRIGR * 4) {
        for (unsigned ch = 0; ch < 2; ch++) {
            if (written & (1u << ch)) {
                dac_convert(s, ch, true);
            }
        }
        return;
    }
    if (off >= 8 && off <= 0x28) {
        merged = (dac_data_read(s, off) & ~mask) | (written & mask);
        dac_data_write(s, off, merged, mask);
        return;
    }
    if (off == D_SR * 4) {
        s->regs[D_SR] &= ~written; /* status: write one to clear */
        return;
    }
    s->regs[off / 4] = (s->regs[off / 4] & ~mask) | (written & mask);
    if (off == D_CR * 4) {
        dac_convert(s, 0, false);
        dac_convert(s, 1, false);
    }
}

static const MemoryRegionOps dac_ops = {
    .read = dac_read,
    .write = dac_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
    .impl.min_access_size = 1,
    .impl.max_access_size = 4,
};

static void gnw_dac_reset(DeviceState *dev)
{
    GnwDacState *s = GNW_DAC(dev);

    memset(s->regs, 0, sizeof(s->regs));
    memset(s->dhr, 0, sizeof(s->dhr));
    memset(s->dor, 0, sizeof(s->dor));
}

static void gnw_dac_init(Object *obj)
{
    GnwDacState *s = GNW_DAC(obj);

    memory_region_init_io(&s->mmio, obj, &dac_ops, s, "dac", 0x400);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->mmio);
}

static const VMStateDescription vmstate_gnw_dac = {
    .name = "gnw_dac",
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32_ARRAY(regs, GnwDacState, 256),
        VMSTATE_UINT16_ARRAY(dhr, GnwDacState, 2),
        VMSTATE_UINT16_ARRAY(dor, GnwDacState, 2),
        VMSTATE_END_OF_LIST()
    },
};

static void gnw_dac_class_init(ObjectClass *klass, const void *data)
{
    DEVICE_CLASS(klass)->vmsd = &vmstate_gnw_dac;
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_dac_reset);
}

static const TypeInfo gnw_dac_info = {
    .name = TYPE_GNW_DAC,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwDacState),
    .instance_init = gnw_dac_init,
    .class_init = gnw_dac_class_init,
};

static void gnw_dac_register_types(void)
{
    type_register_static(&gnw_dac_info);
}

type_init(gnw_dac_register_types)
