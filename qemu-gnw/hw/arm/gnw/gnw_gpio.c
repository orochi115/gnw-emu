/*
 * Game & Watch: GPIO ports A..K, EXTI and SYSCFG (RM0455 sections 11-13, 21).
 *
 * Buttons are external drivers on input pins (active low). Edges on
 * pins routed to EXTI lines 0..15 through SYSCFG_EXTICRx raise the
 * EXTI pending bits and the matching NVIC lines.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "gnw.h"

#define EXTI_RTSR1   (0x00 / 4)
#define EXTI_FTSR1   (0x04 / 4)
#define EXTI_SWIER1  (0x08 / 4)
#define EXTI_IMR1    (0x80 / 4)
#define EXTI_PR1     (0x88 / 4)
#define EXTI_PR2     (0x98 / 4)
#define EXTI_PR3     (0xa8 / 4)

static const uint32_t moder_reset[GNW_GPIO_PORTS] = {
    0xabffffff, 0xfffffebf, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff,
    0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff,
};

static uint16_t port_input(GnwGpioPort *p)
{
    uint16_t in = 0;

    for (int pin = 0; pin < 16; pin++) {
        unsigned mode = extract32(p->moder, pin * 2, 2);
        unsigned pupd = extract32(p->pupdr, pin * 2, 2);
        bool level;

        if (mode == 1) {
            level = extract32(p->odr, pin, 1);
        } else if (p->ext_mask & (1 << pin)) {
            level = p->ext_val & (1 << pin);
        } else {
            level = pupd == 1;
        }
        in |= level << pin;
    }
    return in;
}

static void exti_update(GnwGpioState *s)
{
    uint32_t pend = s->exti[EXTI_PR1] & s->exti[EXTI_IMR1];

    for (int i = 0; i < 5; i++) {
        qemu_set_irq(s->exti_irq[i], extract32(pend, i, 1));
    }
    qemu_set_irq(s->exti_irq[5], extract32(pend, 5, 5) != 0);
    qemu_set_irq(s->exti_irq[6], extract32(pend, 10, 6) != 0);
}

/* Tell board devices (SD card) about pin level changes. */
static void gpio_outputs(GnwGpioState *s, int port, uint16_t in)
{
    uint16_t changed = in ^ s->last_out[port];

    s->last_out[port] = in;
    for (int pin = 0; pin < 16 && changed; pin++) {
        if (changed & (1 << pin)) {
            changed &= ~(1 << pin);
            qemu_set_irq(s->out[GNW_PIN(port, pin)], (in >> pin) & 1);
        }
    }
}

/* Look for edges on pins wired to EXTI lines. */
static void gpio_sample(GnwGpioState *s, int port)
{
    GnwGpioPort *p = &s->port[port];
    uint16_t in = port_input(p);
    uint16_t changed = in ^ p->last_in;

    gpio_outputs(s, port, in);

    p->last_in = in;
    for (int pin = 0; pin < 16 && changed; pin++) {
        if (!(changed & (1 << pin))) {
            continue;
        }
        uint32_t sel = extract32(s->syscfg[(0x08 / 4) + pin / 4],
                                 (pin % 4) * 4, 4);
        if (sel != port) {
            continue;
        }
        bool rising = in & (1 << pin);
        uint32_t edge = rising ? s->exti[EXTI_RTSR1] : s->exti[EXTI_FTSR1];
        if ((edge & (1 << pin)) && (s->exti[EXTI_IMR1] & (1 << pin))) {
            s->exti[EXTI_PR1] |= 1 << pin;
        }
    }
    exti_update(s);
}

void gnw_gpio_set_external(GnwGpioState *s, int port, int pin, bool level)
{
    GnwGpioPort *p = &s->port[port];

    p->ext_mask |= 1 << pin;
    p->ext_val = deposit32(p->ext_val, pin, 1, level);
    gpio_sample(s, port);
}

static uint64_t gpio_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwGpioState *s = opaque;
    int port = addr / 0x400;
    hwaddr off = addr & 0x3fc;
    GnwGpioPort *p = &s->port[port];
    uint32_t v;

    switch (off) {
    case 0x00: v = p->moder; break;
    case 0x04: v = p->otyper; break;
    case 0x08: v = p->ospeedr; break;
    case 0x0c: v = p->pupdr; break;
    case 0x10: v = port_input(p); break;
    case 0x14: v = p->odr; break;
    case 0x1c: v = p->lckr; break;
    case 0x20: v = p->afr[0]; break;
    case 0x24: v = p->afr[1]; break;
    default: v = 0; break;
    }
    return v >> ((addr & 3) * 8);
}

static void gpio_write(void *opaque, hwaddr addr, uint64_t value,
                       unsigned size)
{
    GnwGpioState *s = opaque;
    int port = addr / 0x400;
    hwaddr off = addr & 0x3fc;
    GnwGpioPort *p = &s->port[port];
    uint32_t *r = NULL;
    unsigned shift = (addr & 3) * 8;
    uint32_t mask = (size == 4 ? 0xffffffffu : ((1u << (size * 8)) - 1))
                    << shift;
    uint32_t val = (uint32_t)value << shift;

    switch (off) {
    case 0x00: r = &p->moder; break;
    case 0x04: r = &p->otyper; break;
    case 0x08: r = &p->ospeedr; break;
    case 0x0c: r = &p->pupdr; break;
    case 0x14: r = &p->odr; break;
    case 0x1c: r = &p->lckr; break;
    case 0x20: r = &p->afr[0]; break;
    case 0x24: r = &p->afr[1]; break;
    case 0x18: /* BSRR */
        val &= mask;
        p->odr = (p->odr | (val & 0xffff)) & ~((val >> 16) & ~(val & 0xffff));
        gpio_sample(s, port);
        return;
    default:
        return;
    }
    *r = (*r & ~mask) | (val & mask);
    gpio_sample(s, port);
}

static const MemoryRegionOps gpio_ops = {
    .read = gpio_read,
    .write = gpio_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
};

static uint64_t exti_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwGpioState *s = opaque;

    return s->exti[addr / 4] >> ((addr & 3) * 8);
}

static void exti_write(void *opaque, hwaddr addr, uint64_t value,
                       unsigned size)
{
    GnwGpioState *s = opaque;
    int idx = addr / 4;
    uint32_t val = value << ((addr & 3) * 8);

    switch (idx) {
    case EXTI_PR1: case EXTI_PR2: case EXTI_PR3:
        s->exti[idx] &= ~val;
        break;
    case EXTI_SWIER1:
        s->exti[EXTI_PR1] |= val & s->exti[EXTI_IMR1];
        break;
    default:
        s->exti[idx] = val;
        break;
    }
    exti_update(s);
}

static const MemoryRegionOps exti_ops = {
    .read = exti_read,
    .write = exti_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static uint64_t syscfg_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwGpioState *s = opaque;
    uint32_t v = s->syscfg[addr / 4];

    if (addr == 0x20) {
        v |= 1 << 8;            /* CCCSR: compensation cell ready */
    }
    return v;
}

static void syscfg_write(void *opaque, hwaddr addr, uint64_t value,
                         unsigned size)
{
    GnwGpioState *s = opaque;

    s->syscfg[addr / 4] = value;
}

static const MemoryRegionOps syscfg_ops = {
    .read = syscfg_read,
    .write = syscfg_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gnw_gpio_reset(DeviceState *dev)
{
    GnwGpioState *s = GNW_GPIO(dev);

    for (int i = 0; i < GNW_GPIO_PORTS; i++) {
        GnwGpioPort *p = &s->port[i];
        uint16_t mask = p->ext_mask, val = p->ext_val;

        memset(p, 0, sizeof(*p));
        p->ext_mask = mask;
        p->ext_val = val;
        p->moder = moder_reset[i];
        if (i == 0) {
            p->ospeedr = 0x0c000000;
            p->pupdr = 0x64000000;
        } else if (i == 1) {
            p->ospeedr = 0x000000c0;
            p->pupdr = 0x00000100;
        }
        p->last_in = port_input(p);
        s->last_out[i] = p->last_in;
    }
    memset(s->exti, 0, sizeof(s->exti));
    memset(s->syscfg, 0, sizeof(s->syscfg));
    exti_update(s);
}

static void gnw_gpio_init(Object *obj)
{
    GnwGpioState *s = GNW_GPIO(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->gpio_mmio, obj, &gpio_ops, s, "gpio",
                          GNW_GPIO_PORTS * 0x400);
    memory_region_init_io(&s->exti_mmio, obj, &exti_ops, s, "exti", 0x100);
    memory_region_init_io(&s->syscfg_mmio, obj, &syscfg_ops, s, "syscfg",
                          0x400);
    sysbus_init_mmio(sbd, &s->gpio_mmio);
    sysbus_init_mmio(sbd, &s->exti_mmio);
    sysbus_init_mmio(sbd, &s->syscfg_mmio);
    for (int i = 0; i < 7; i++) {
        sysbus_init_irq(sbd, &s->exti_irq[i]);
    }
    qdev_init_gpio_out_named(DEVICE(obj), s->out, "pin",
                             GNW_GPIO_PORTS * 16);
}

static void gnw_gpio_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_gpio_reset);
}

static const TypeInfo gnw_gpio_info = {
    .name = TYPE_GNW_GPIO,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwGpioState),
    .instance_init = gnw_gpio_init,
    .class_init = gnw_gpio_class_init,
};

static void gnw_gpio_register_types(void)
{
    type_register_static(&gnw_gpio_info);
}

type_init(gnw_gpio_register_types)
