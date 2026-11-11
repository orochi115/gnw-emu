/*
 * Game & Watch: generic read-back register files and the simple
 * peripherals built on top of them (RCC, PWR, SPI2, HASH, ...).
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
#include "gnw_state.h"

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

static bool regs_buffer_save(QEMUFile *f, void *pv, size_t size,
                             const VMStateField *field, JSONWriter *vmdesc,
                             Error **errp)
{
    GnwRegs *s = pv;
    return gnw_put_blob(f, s->hash_msg ? s->hash_msg->data : NULL,
                        s->hash_msg ? s->hash_msg->len : 0, 64 * 1024 * 1024,
                        errp);
}
static bool regs_buffer_load(QEMUFile *f, void *pv, size_t size,
                             const VMStateField *field, Error **errp)
{
    GnwRegs *s = pv;
    uint8_t *data = NULL;
    uint32_t len = 0;
    if (!gnw_get_blob(f, &data, &len, 64 * 1024 * 1024, errp)) {
        return false;
    }
    if (s->hash_msg) {
        g_byte_array_unref(s->hash_msg);
    }
    s->hash_msg = g_byte_array_new_take(data, len);
    return true;
}
static const VMStateInfo regs_buffer = {
    .name = "hash-input", .save = regs_buffer_save, .load = regs_buffer_load};
static const VMStateDescription vmstate_gnw_regs = {
    .name = "gnw_regs",
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32_ARRAY(regs, GnwRegs, 1024),
        GNW_STATE_BUFFERS(regs_buffer),
        VMSTATE_END_OF_LIST()
    },
};

static void gnw_regs_class_init(ObjectClass *klass, const void *data)
{
    DEVICE_CLASS(klass)->vmsd = &vmstate_gnw_regs;
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
/* DBGMCU                                                               */

static void dbgmcu_reset(GnwRegs *s)
{
    s->regs[0] = 0x10016480;            /* STM32H7B0, REV_ID 0x1001 as read on the device */
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

/* ------------------------------------------------------------------ */
/* HASH: SHA-1/SHA-224/SHA-256/MD5 over the words written to DIN.       */


static void hash_write(GnwRegs *s, hwaddr off, uint32_t old, uint32_t v)
{
    uint32_t cr = s->regs[0];

    if (!s->hash_msg) {
        s->hash_msg = g_byte_array_new();
    }
    if (off == 0x00 && (v & (1 << 2))) {        /* CR.INIT */
        g_byte_array_set_size(s->hash_msg, 0);
        s->regs[0] &= ~(1 << 2);
        s->regs[0x24 / 4] &= ~(1 << 1);
    } else if (off == 0x04) {                   /* DIN */
        uint8_t b[4];
        switch (extract32(cr, 4, 2)) {          /* DATATYPE swapping */
        case 0: stl_be_p(b, v); break;
        case 1: stl_be_p(b, (v << 16) | (v >> 16)); break;
        default: stl_le_p(b, v); break;         /* 8-bit data (and bit) */
        }
        g_byte_array_append(s->hash_msg, b, 4);
    } else if (off == 0x08 && (v & (1 << 8))) { /* STR.DCAL */
        unsigned nblw = v & 0x1f;
        unsigned algo = extract32(cr, 7, 1) | extract32(cr, 18, 1) << 1;
        static const GChecksumType types[4] = {
            G_CHECKSUM_SHA1, G_CHECKSUM_MD5, G_CHECKSUM_SHA256,
            G_CHECKSUM_SHA256,
        };
        guint len = s->hash_msg->len;
        uint8_t digest[32];
        gsize dlen = sizeof(digest);
        GChecksum *ck;

        if (nblw && len >= 4) {
            len -= 4 - (nblw + 7) / 8;
        }
        if (algo == 2) {
            qemu_log_mask(LOG_UNIMP, "hash: SHA-224 not supported\n");
        }
        ck = g_checksum_new(types[algo]);
        g_checksum_update(ck, s->hash_msg->data, len);
        g_checksum_get_digest(ck, digest, &dlen);
        g_checksum_free(ck);
        for (unsigned i = 0; i < dlen / 4; i++) {
            uint32_t w = ldl_be_p(digest + 4 * i);
            if (i < 5) {
                s->regs[0x0c / 4 + i] = w;
            }
            s->regs[0x310 / 4 + i] = w;
        }
        if (algo == 1) {                        /* MD5 digest is LE */
            for (unsigned i = 0; i < 4; i++) {
                s->regs[0x0c / 4 + i] = s->regs[0x310 / 4 + i] =
                    ldl_le_p(digest + 4 * i);
            }
        }
        s->regs[0x08 / 4] &= ~(1 << 8);
        s->regs[0x24 / 4] |= 1 << 1;            /* SR.DCIS */
        g_byte_array_set_size(s->hash_msg, 0);
    }
}

static uint32_t hash_read(GnwRegs *s, hwaddr off, uint32_t v)
{
    if (off == 0x24) {                          /* SR: DIN always ready */
        return (v & (1 << 1)) | 1;
    }
    return v;
}

GnwRegs *gnw_regs_create_stubs(void)
{
    GnwRegs *rcc = gnw_regs_create("rcc", 0x58024400, 0x400, rcc_read, NULL,
                                   rcc_reset);

    gnw_pwr = gnw_regs_create("pwr", 0x58024800, 0x400, pwr_read, pwr_write,
                              pwr_reset);
    gnw_regs_create("spi2", 0x40003800, 0x400, spi_read, NULL, NULL);
    gnw_regs_create("dbgmcu", 0x5c001000, 0x400, NULL, NULL, dbgmcu_reset);
    gnw_regs_create("hsem", 0x58026400, 0x400, hsem_read, NULL, NULL);
    gnw_regs_create("hash", 0x48021400, 0x400, hash_read, hash_write, NULL);
    gnw_regs_create("crc", 0x58024c00, 0x400, NULL, crc_write, crc_reset);
    gnw_regs_create("octospim", 0x5200b400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("dmamux2", 0x58025800, 0x400, NULL, NULL, NULL);
    gnw_regs_create("bdma", 0x58025400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("mdma", 0x52000000, 0x1000, NULL, NULL, NULL);
    gnw_regs_create("sai2", 0x40015c00, 0x400, NULL, NULL, NULL);
    gnw_regs_create("i2c1", 0x40005400, 0x400, NULL, NULL, NULL);
    gnw_regs_create("iwdg", 0x58004800, 0x400, NULL, NULL, NULL);
    gnw_regs_create("lptim1", 0x40002400, 0x400, NULL, NULL, NULL);
    return rcc;
}
