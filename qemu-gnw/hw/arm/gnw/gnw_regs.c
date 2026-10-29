/*
 * Game & Watch: generic read-back register files and the simple
 * peripherals built on top of them (RCC, PWR, FLASH, SPI2, ADC, ...).
 *
 * Every write is stored and read back. Peripheral specific hooks set
 * the status bits the stock firmware polls on (ready flags etc.).
 * Writes are logged with -d unimp, reads the first time an offset is read.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "hw/core/qdev-properties.h"
#include "gnw.h"

static uint64_t gnw_regs_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwRegs *s = opaque;
    hwaddr off = addr & ~3;
    uint32_t val = s->regs[off / 4];

    if (s->read_fn) {
        val = s->read_fn(s, off, val);
    }
    if (!s->seen[off / 4]) {
        s->seen[off / 4] = 1;
        qemu_log_mask(LOG_UNIMP, "%s: read  0x%03" HWADDR_PRIx " -> 0x%08x\n",
                      s->name, off, val);
    }
    return val >> ((addr & 3) * 8);
}

static void gnw_regs_write(void *opaque, hwaddr addr, uint64_t value,
                           unsigned size)
{
    GnwRegs *s = opaque;
    hwaddr off = addr & ~3;
    unsigned shift = (addr & 3) * 8;
    uint32_t mask = (size == 4 ? 0xffffffffu : ((1u << (size * 8)) - 1))
                    << shift;
    uint32_t old = s->regs[off / 4];
    uint32_t val = (old & ~mask) | (((uint32_t)value << shift) & mask);

    qemu_log_mask(LOG_UNIMP, "%s: write 0x%03" HWADDR_PRIx " <- 0x%08x\n",
                  s->name, off, val);
    s->regs[off / 4] = val;
    if (s->write_fn) {
        s->write_fn(s, off, old, val);
    }
}

static const MemoryRegionOps gnw_regs_ops = {
    .read = gnw_regs_read,
    .write = gnw_regs_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
    .impl.min_access_size = 1,
    .impl.max_access_size = 4,
};

static void gnw_regs_reset(DeviceState *dev)
{
    GnwRegs *s = GNW_REGS(dev);

    memset(s->regs, 0, sizeof(s->regs));
    if (s->reset_fn) {
        s->reset_fn(s);
    }
}

static void gnw_regs_realize(DeviceState *dev, Error **errp)
{
    GnwRegs *s = GNW_REGS(dev);

    if (s->size == 0 || s->size > GNW_REGS_MAX) {
        error_setg(errp, "gnw-regs: bad size");
        return;
    }
    memory_region_init_io(&s->mmio, OBJECT(s), &gnw_regs_ops, s,
                          s->name ? s->name : "gnw-regs", s->size);
    sysbus_init_mmio(SYS_BUS_DEVICE(s), &s->mmio);
    sysbus_init_irq(SYS_BUS_DEVICE(s), &s->irq);
}

static const Property gnw_regs_props[] = {
    DEFINE_PROP_STRING("name", GnwRegs, name),
    DEFINE_PROP_UINT32("size", GnwRegs, size, 0x400),
};

static void gnw_regs_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->realize = gnw_regs_realize;
    device_class_set_legacy_reset(dc, gnw_regs_reset);
    device_class_set_props(dc, gnw_regs_props);
}

static const TypeInfo gnw_regs_info = {
    .name = TYPE_GNW_REGS,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwRegs),
    .class_init = gnw_regs_class_init,
};

static void gnw_regs_register_types(void)
{
    type_register_static(&gnw_regs_info);
}

type_init(gnw_regs_register_types)

GnwRegs *gnw_regs_create(const char *name, hwaddr base, uint32_t size,
                         GnwRegsReadFn rfn, GnwRegsWriteFn wfn,
                         void (*reset_fn)(GnwRegs *s))
{
    DeviceState *dev = qdev_new(TYPE_GNW_REGS);
    GnwRegs *s = GNW_REGS(dev);

    qdev_prop_set_string(dev, "name", name);
    qdev_prop_set_uint32(dev, "size", size);
    s->read_fn = rfn;
    s->write_fn = wfn;
    s->reset_fn = reset_fn;
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    sysbus_mmio_map(SYS_BUS_DEVICE(dev), 0, base);
    return s;
}

GnwRegs *gnw_pwr;

/* ------------------------------------------------------------------ */
/* RCC (RM0455 section 8)                                               */

static uint32_t rcc_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    switch (off) {
    case 0x00: { /* CR: every xxxRDY follows its xxxON */
        static const int pairs[][2] = {
            {0, 2}, {7, 8}, {12, 13}, {16, 17}, {24, 25}, {26, 27}, {28, 29},
        };
        for (int i = 0; i < ARRAY_SIZE(pairs); i++) {
            v = deposit32(v, pairs[i][1], 1, extract32(v, pairs[i][0], 1));
        }
        v |= (1 << 14) | (1 << 15);     /* CPUCKRDY, CDCKRDY */
        return v;
    }
    case 0x10: /* CFGR: SWS follows SW */
        return deposit32(v, 3, 3, extract32(v, 0, 3));
    case 0x70: /* BDCR: LSERDY follows LSEON */
        return deposit32(v, 1, 1, extract32(v, 0, 1));
    case 0x74: /* CSR: LSIRDY follows LSION */
        return deposit32(v, 1, 1, extract32(v, 0, 1));
    }
    return v;
}

static void rcc_reset(GnwRegs *s)
{
    s->regs[0x00 / 4] = 0x00000025;     /* HSION, HSIRDY, HSIDIVF */
    s->regs[0x70 / 4] = 0x00000001;     /* LSE was already running */
    s->regs[0xd0 / 4] = 0x00c00000;     /* RSR: PINRSTF | PORRSTF */
}

/* ------------------------------------------------------------------ */
/* PWR                                                                  */

static uint32_t pwr_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    uint32_t vos = extract32(s->regs[0x18 / 4], 14, 2);

    switch (off) {
    case 0x04: /* CSR1: ACTVOSRDY, ACTVOS = SRDCR.VOS */
        return (v & ~0xe000) | (1 << 13) | (vos << 14);
    case 0x0c: /* CR3: USB33RDY, SMPSEXTRDY */
        return v | (1 << 26) | (1 << 16);
    case 0x18: /* SRDCR: VOSRDY */
        return v | (1 << 13);
    }
    return v;
}

/*
 * Standby: the firmware arms PWR_CPUCR.PDDS_SRD and executes WFI. The board
 * code resets the machine when the power button is pressed in that state;
 * the reset then looks like a wakeup from standby through WKUP1 (PA0).
 */
bool gnw_pwr_standby_armed(void)
{
    return gnw_pwr && (gnw_pwr->regs[0x10 / 4] & (1 << 2));
}

static void pwr_write(GnwRegs *s, hwaddr off, uint32_t old, uint32_t v)
{
    switch (off) {
    case 0x10:                  /* CPUCR: STOPF/SBF are read-only flags */
        v = (v & ~0x3e0) | (old & 0x1e0);
        if (v & (1 << 9)) {     /* CSSF */
            v &= ~0x1e0;
        }
        s->regs[0x10 / 4] = v & ~(1 << 9);
        break;
    case 0x20:                  /* WKUPCR: clear wakeup flags */
        s->regs[0x24 / 4] &= ~(v & 0x3f);
        s->regs[0x20 / 4] = 0;
        break;
    }
}

static void pwr_reset(GnwRegs *s)
{
    s->regs[0x00 / 4] = 0xf000c000;
    s->regs[0x0c / 4] = 0x00000006;
    s->regs[0x18 / 4] = 0x00004000;
    /* Every power-on is a wakeup from standby by the power button (WKUP1). */
    s->regs[0x10 / 4] = 1 << 6;         /* CPUCR.SBF */
    s->regs[0x24 / 4] = 0x00000001;     /* WKUPFR.WKUPF1 */
}

/* ------------------------------------------------------------------ */
/* Embedded flash interface: nothing ever busy.                         */

static uint32_t flash_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    switch (off) {
    case 0x10: case 0x110:     /* SR1/SR2: BSY, QW, WBNE clear */
        return v & ~0x7;
    }
    return v;
}

static void flash_reset(GnwRegs *s)
{
    s->regs[0x0c / 4] = 0x00000031;     /* CR1: LOCK */
    s->regs[0x10c / 4] = 0x00000031;
    s->regs[0x1c / 4] = 0x0000aaf0;     /* OPTSR_CUR: RDP level 0 look */
}

/* ------------------------------------------------------------------ */
/* SPI2 (LCD panel setup): every transfer completes immediately.         */

static uint32_t spi_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    switch (off) {
    case 0x00: /* CR1: CSTART self-clears */
        return v & ~(1 << 9);
    case 0x14: /* SR: TXP, EOT, TXTF, TXC; no RX data */
        return (1 << 1) | (1 << 3) | (1 << 4) | (1 << 12);
    }
    return v;
}

/* ------------------------------------------------------------------ */
/* ADC1/ADC2 (battery measurement)                                      */

static uint32_t adc_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    hwaddr r = off & 0xff;

    if ((off & 0x300) == 0x300) {
        return v;               /* common registers */
    }
    switch (r) {
    case 0x00: /* ISR: ADRDY, EOSMP, EOC, EOS */
        return v | 0xf;
    case 0x08: /* CR: ADCAL, ADSTART, ADSTP, ADDIS self-clear */
        return v & ~((1u << 31) | (1 << 2) | (1 << 4) | (1 << 1));
    case 0x40: /* DR: plenty of battery */
        return 0xe000;
    }
    return v;
}

static void adc_write(GnwRegs *s, hwaddr off, uint32_t old, uint32_t v)
{
    if ((off & 0x300) != 0x300 && (off & 0xff) == 0x00) {
        s->regs[off / 4] = old & ~v;    /* ISR: write 1 to clear */
    }
}

/* ------------------------------------------------------------------ */
/* DBGMCU                                                               */

static void dbgmcu_reset(GnwRegs *s)
{
    s->regs[0] = 0x10036480;            /* STM32H7B0, rev Z */
}

/* ------------------------------------------------------------------ */
/* HSEM: the semaphore is always free.                                  */

static uint32_t hsem_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    if (off >= 0x80 && off < 0x100) {   /* RLR: one step lock succeeds */
        return 0x80000000 | (s->regs[(off - 0x80) / 4] & 0xffff);
    }
    return v;
}

/* ------------------------------------------------------------------ */
/* CRC unit: STM32 default CRC-32 (poly 0x04C11DB7, init 0xFFFFFFFF).    */

static void crc_write(GnwRegs *s, hwaddr off, uint32_t old, uint32_t v)
{
    if (off == 0x08 && (v & 1)) {       /* CR.RESET */
        s->regs[0] = s->regs[0x10 / 4];
        s->regs[0x08 / 4] &= ~1;
    } else if (off == 0x00) {
        uint32_t crc = old;
        for (int i = 31; i >= 0; i--) {
            uint32_t bit = ((crc >> 31) ^ (v >> i)) & 1;
            crc = (crc << 1) ^ (bit ? s->regs[0x14 / 4] : 0);
        }
        s->regs[0] = crc;
    }
}

static void crc_reset(GnwRegs *s)
{
    s->regs[0x00 / 4] = 0xffffffff;
    s->regs[0x10 / 4] = 0xffffffff;
    s->regs[0x14 / 4] = 0x04c11db7;
}

GnwRegs *gnw_regs_create_stubs(void)
{
    GnwRegs *rcc = gnw_regs_create("rcc", 0x58024400, 0x400, rcc_read, NULL,
                                   rcc_reset);

    gnw_pwr = gnw_regs_create("pwr", 0x58024800, 0x400, pwr_read, pwr_write,
                              pwr_reset);
    gnw_regs_create("flash-if", 0x52002000, 0x1000, flash_read, NULL,
                    flash_reset);
    gnw_regs_create("spi2", 0x40003800, 0x400, spi_read, NULL, NULL);
    gnw_regs_create("adc12", 0x40022000, 0x400, adc_read, adc_write, NULL);
    gnw_regs_create("dbgmcu", 0x5c001000, 0x400, NULL, NULL, dbgmcu_reset);
    gnw_regs_create("hsem", 0x58026400, 0x400, hsem_read, NULL, NULL);
    gnw_regs_create("crc", 0x58024c00, 0x400, NULL, crc_write, crc_reset);
    gnw_regs_create("octospim", 0x5200b400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("dmamux2", 0x58025800, 0x400, NULL, NULL, NULL);
    gnw_regs_create("bdma", 0x58025400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("mdma", 0x52000000, 0x1000, NULL, NULL, NULL);
    gnw_regs_create("sai2", 0x40015c00, 0x400, NULL, NULL, NULL);
    gnw_regs_create("i2c1", 0x40005400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("iwdg", 0x58004800, 0x400, NULL, NULL, NULL);
    gnw_regs_create("dac1", 0x40007400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("lptim1", 0x40002400, 0x400, NULL, NULL, NULL);
    return rcc;
}
