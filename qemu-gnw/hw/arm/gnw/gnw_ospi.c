/*
 * Game & Watch: OCTOSPI1, OTFDEC1 and the Macronix MX25U SPI NOR flash.
 *
 * Indirect and automatic-polling transfers are decoded as flash commands
 * against the backing store. The memory-mapped window at 0x90000000 is a
 * ROM region holding the flash contents with all enabled OTFDEC regions
 * already decrypted, so TCG can execute from it at full speed. It is
 * rebuilt whenever OTFDEC is reconfigured or the flash is programmed.
 *
 * The OTFDEC key is whatever the firmware writes into RxKEYR; nothing is
 * baked in here.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/units.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "system/address-spaces.h"
#include "gnw.h"

#define XIP_BASE        0x90000000

/* OCTOSPI register offsets */
#define R_CR            (0x000 / 4)
#define R_DCR1          (0x008 / 4)
#define R_SR            (0x020 / 4)
#define R_FCR           (0x024 / 4)
#define R_DLR           (0x040 / 4)
#define R_AR            (0x048 / 4)
#define R_DR            (0x050 / 4)
#define R_PSMKR         (0x080 / 4)
#define R_PSMAR         (0x088 / 4)
#define R_CCR           (0x100 / 4)
#define R_IR            (0x110 / 4)

#define SR_TEF          (1 << 0)
#define SR_TCF          (1 << 1)
#define SR_FTF          (1 << 2)
#define SR_SMF          (1 << 3)
#define SR_BUSY         (1 << 5)

#define CR_FMODE(cr)    extract32(cr, 28, 2)
#define FMODE_IWRITE    0
#define FMODE_IREAD     1
#define FMODE_POLL      2
#define FMODE_MMAP      3

#define CCR_ADMODE(c)   extract32(c, 8, 3)
#define CCR_ADSIZE(c)   extract32(c, 12, 2)
#define CCR_DMODE(c)    extract32(c, 24, 3)

/* MX25U status register */
#define ST_WIP          (1 << 0)
#define ST_WEL          (1 << 1)

/* ------------------------------------------------------------------ */
/* OTFDEC                                                               */

#define OTF_REGION(n)   ((0x20 + (n) * 0x30) / 4)
#define OTF_CFGR        0
#define OTF_START       1
#define OTF_END         2
#define OTF_NONCE0      3
#define OTF_NONCE1      4
#define OTF_KEY0        5

static void otfdec_keystream(const AES_KEY *key, const uint32_t *r, int n,
                             uint32_t addr, uint8_t ks[16])
{
    uint8_t in[16], out[16];
    uint32_t w[4] = {
        r[OTF_NONCE1],
        r[OTF_NONCE0],
        extract32(r[OTF_CFGR], 16, 16),
        ((uint32_t)n << 28) | ((addr >> 4) & 0x0fffffff),
    };

    for (int i = 0; i < 4; i++) {
        stl_be_p(in + i * 4, w[i]);
    }
    AES_encrypt(in, out, key);
    for (int i = 0; i < 16; i++) {
        ks[i] = out[15 - i];
    }
}

/* Rebuild the decrypted view for [off, off + len). */
static void xip_refresh(GnwOspiState *s, uint32_t off, uint32_t len)
{
    uint8_t *view;

    if (off >= s->flash_size) {
        return;
    }
    len = MIN(len, s->flash_size - off);
    view = g_malloc(len);
    memcpy(view, s->flash + off, len);

    for (int n = 0; n < 4; n++) {
        const uint32_t *r = &s->otfdec[OTF_REGION(n)];
        uint32_t lo, hi, a;
        uint8_t keyb[16];
        AES_KEY key;

        if (!(r[OTF_CFGR] & 1)) {
            continue;
        }
        lo = MAX(r[OTF_START] & ~0xfffu, XIP_BASE + off);
        hi = MIN((r[OTF_END] | 0xfff) + 1, XIP_BASE + off + len);
        if (lo >= hi) {
            continue;
        }
        for (int i = 0; i < 4; i++) {
            stl_be_p(keyb + i * 4, r[OTF_KEY0 + 3 - i]);
        }
        AES_set_encrypt_key(keyb, 128, &key);
        for (a = lo & ~15u; a < hi; a += 16) {
            uint8_t ks[16];
            otfdec_keystream(&key, r, n, a, ks);
            for (int i = 0; i < 16; i++) {
                uint32_t p = a + i - XIP_BASE - off;
                if (a + i >= lo && a + i < hi) {
                    view[p] ^= ks[i];
                }
            }
        }
    }
    /* Writes through the ROM path so stale translated code is dropped. */
    address_space_write_rom(&address_space_memory, XIP_BASE + off,
                            MEMTXATTRS_UNSPECIFIED, view, len);
    g_free(view);
}

/*
 * KEYCRC as computed by the hardware once all four key words are written.
 * Same algorithm as HAL_OTFDEC_KeyCRCComputation() in ST's
 * stm32h7xx-hal-driver, which the firmware uses to check it.
 */
static uint8_t otfdec_key_crc(const uint32_t *key)
{
    static const uint32_t strobe[4] = { 0xaa55aa55, 0x3, 0x18, 0xc0 };
    uint8_t crc = 0;

    for (int j = 0; j < 4; j++) {
        uint32_t v = key[j];

        if (j == 0) {
            v ^= strobe[0];
        } else {
            v ^= (strobe[j] << 24) | ((uint32_t)crc << 16) |
                 (strobe[j] << 8) | crc;
        }
        crc = 0;
        for (int i = 0; i < 32; i++) {
            uint32_t k = ((crc >> 7) ^ (v >> (31 - i))) & 1;
            crc <<= 1;
            if (k) {
                crc ^= 0x7;
            }
        }
        crc ^= 0x55;
    }
    return crc;
}

static uint64_t otfdec_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwOspiState *s = opaque;

    if (addr >= 0x20 && addr < 0x140) {
        int field = ((addr - 0x20) % 0x30) / 4;
        if (field >= OTF_KEY0 && field < OTF_KEY0 + 4) {
            return 0;           /* keys are write-only */
        }
    }
    return s->otfdec[addr / 4];
}

static void otfdec_write(void *opaque, hwaddr addr, uint64_t value,
                         unsigned size)
{
    GnwOspiState *s = opaque;
    uint32_t old = s->otfdec[addr / 4];

    s->otfdec[addr / 4] = value;
    if (addr >= 0x20 && addr < 0x140) {
        int n = (addr - 0x20) / 0x30;
        int field = ((addr - 0x20) % 0x30) / 4;
        uint32_t *r = &s->otfdec[OTF_REGION(n)];
        uint32_t cfg;

        if (field == OTF_CFGR) {        /* KEYCRC is read-only */
            r[OTF_CFGR] = (value & ~0xff00) | (old & 0xff00);
        } else if (field == OTF_KEY0 + 3) {
            r[OTF_CFGR] = deposit32(r[OTF_CFGR], 8, 8,
                                    otfdec_key_crc(&r[OTF_KEY0]));
        }
        cfg = r[OTF_CFGR];

        if (field == OTF_CFGR) {
            qemu_log_mask(LOG_UNIMP, "otfdec: region %d cfg 0x%08x "
                          "[0x%08x..0x%08x]\n", n, (uint32_t)value,
                          s->otfdec[OTF_REGION(n) + OTF_START],
                          s->otfdec[OTF_REGION(n) + OTF_END]);
        }
        if ((field == OTF_CFGR && ((old ^ value) & 0xffff0031)) ||
            (field != OTF_CFGR && (cfg & 1))) {
            xip_refresh(s, 0, s->flash_size);
        }
    } else if (addr == 0x304) {
        s->otfdec[0x300 / 4] &= ~value;
    }
}

static const MemoryRegionOps otfdec_ops = {
    .read = otfdec_read,
    .write = otfdec_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

/* ------------------------------------------------------------------ */
/* Flash chip                                                           */

static void flash_persist(GnwOspiState *s, uint32_t off, uint32_t len)
{
    int fd;

    xip_refresh(s, off & ~15u, ROUND_UP(len + (off & 15), 16));
    if (!s->overlay_path) {
        return;
    }
    fd = open(s->overlay_path, O_WRONLY);
    if (fd < 0 || pwrite(fd, s->flash + off, len, off) != len) {
        qemu_log_mask(LOG_GUEST_ERROR, "gnw-ospi: cannot write %s\n",
                      s->overlay_path);
    }
    if (fd >= 0) {
        close(fd);
    }
}

static uint32_t flash_addr(GnwOspiState *s)
{
    return s->regs[R_AR] & (s->flash_size - 1);
}

static void flash_erase(GnwOspiState *s, uint32_t addr, uint32_t len)
{
    if (!(s->status & ST_WEL)) {
        return;
    }
    addr &= ~(len - 1);
    memset(s->flash + addr, 0xff, len);
    s->status &= ~ST_WEL;
    flash_persist(s, addr, len);
}

/* Commands without a data phase or with data written by the host. */
static void flash_command_write(GnwOspiState *s, const uint8_t *data,
                                uint32_t len)
{
    uint8_t cmd = s->regs[R_IR] & 0xff;
    uint32_t addr = flash_addr(s);

    switch (cmd) {
    case 0x06: s->status |= ST_WEL; break;
    case 0x04: s->status &= ~ST_WEL; break;
    case 0x01: /* WRSR */
        if (len > 0) {
            s->status = (s->status & 3) | (data[0] & 0xfc);
        }
        if (len > 1) {
            s->config = data[1];
        }
        s->status &= ~ST_WEL;
        break;
    case 0x02: case 0x38: case 0x12: case 0x3e: { /* PP, 4PP */
        uint32_t page = addr & ~0xffu;
        if (!(s->status & ST_WEL)) {
            break;
        }
        for (uint32_t i = 0; i < len; i++) {
            uint32_t a = page + ((addr + i) & 0xff);
            s->flash[a] &= data[i];
        }
        s->status &= ~ST_WEL;
        flash_persist(s, page, 256);
        break;
    }
    case 0x20: case 0x21: flash_erase(s, addr, 4 * KiB); break;
    case 0x52: case 0x5c: flash_erase(s, addr, 32 * KiB); break;
    case 0xd8: case 0xdc: flash_erase(s, addr, 64 * KiB); break;
    case 0x60: case 0xc7: flash_erase(s, 0, s->flash_size); break;
    case 0x66: case 0x99: case 0xb9: case 0xab: case 0x35: case 0xf5:
    case 0xb0: case 0x30: case 0xc0:
        break;
    default:
        qemu_log_mask(LOG_UNIMP, "gnw-ospi: write command 0x%02x\n", cmd);
        break;
    }
}

/* Commands that return data: fill the FIFO. */
static void flash_command_read(GnwOspiState *s, uint8_t *out, uint32_t len)
{
    uint8_t cmd = s->regs[R_IR] & 0xff;
    uint32_t addr = flash_addr(s);

    memset(out, 0, len);
    switch (cmd) {
    case 0x9f: case 0xaf: case 0x9e:
        memcpy(out, s->jedec, MIN(len, 3));
        break;
    case 0x05:
        for (uint32_t i = 0; i < len; i++) {
            out[i] = s->status;
        }
        break;
    case 0x15:
        out[0] = s->config;
        break;
    case 0x03: case 0x0b: case 0x3b: case 0x6b: case 0xbb: case 0xeb:
    case 0x13: case 0x0c: case 0x3c: case 0x6c: case 0xbc: case 0xec:
        for (uint32_t i = 0; i < len; i++) {
            out[i] = s->flash[(addr + i) & (s->flash_size - 1)];
        }
        break;
    case 0x5a: case 0x2b: case 0x48:
        break;
    default:
        qemu_log_mask(LOG_UNIMP, "gnw-ospi: read command 0x%02x\n", cmd);
        break;
    }
}

/* ------------------------------------------------------------------ */
/* OCTOSPI                                                              */

static void ospi_update_irq(GnwOspiState *s)
{
    uint32_t ie = extract32(s->regs[R_CR], 16, 5);
    uint32_t fl = s->regs[R_SR] & 0x1f;

    qemu_set_irq(s->irq, (ie & fl) != 0);
}

static uint32_t ospi_data_len(GnwOspiState *s)
{
    return CCR_DMODE(s->regs[R_CCR]) ? s->regs[R_DLR] + 1 : 0;
}

/* Start whatever transfer the current configuration describes. */
static void ospi_start(GnwOspiState *s)
{
    uint32_t mode = CR_FMODE(s->regs[R_CR]);
    uint32_t len = ospi_data_len(s);

    s->fifo_len = s->fifo_pos = 0;
    qemu_log_mask(LOG_UNIMP, "gnw-ospi: fmode %u cmd 0x%02x addr 0x%08x "
                  "len %u ccr 0x%08x\n", mode, s->regs[R_IR] & 0xff,
                  s->regs[R_AR], len, s->regs[R_CCR]);
    switch (mode) {
    case FMODE_IWRITE:
        if (len == 0) {
            flash_command_write(s, NULL, 0);
            s->regs[R_SR] |= SR_TCF;
        } else {
            g_free(s->wbuf);
            s->wbuf = g_malloc(len);
            s->wexp = len;
            s->wlen = 0;
            s->regs[R_SR] |= SR_FTF;
        }
        break;
    case FMODE_IREAD:
        g_free(s->fifo);
        s->fifo = g_malloc(MAX(len, 1));
        flash_command_read(s, s->fifo, len);
        s->fifo_len = len;
        s->regs[R_SR] |= SR_TCF | (len ? SR_FTF : 0);
        break;
    case FMODE_POLL: {
        uint8_t buf[4];
        uint32_t v = 0;
        len = MIN(MAX(len, 1), 4);
        flash_command_read(s, buf, len);
        for (uint32_t i = 0; i < len; i++) {
            v |= buf[i] << (i * 8);
        }
        s->regs[R_DR] = v;
        if ((v & s->regs[R_PSMKR]) == (s->regs[R_PSMAR] & s->regs[R_PSMKR])) {
            s->regs[R_SR] |= SR_SMF | SR_TCF;
        } else {
            qemu_log_mask(LOG_GUEST_ERROR,
                          "gnw-ospi: poll 0x%02x never matches (0x%x)\n",
                          s->regs[R_IR] & 0xff, v);
        }
        break;
    }
    case FMODE_MMAP:
        break;
    }
    ospi_update_irq(s);
}

static uint64_t ospi_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwOspiState *s = opaque;
    uint32_t v;

    if ((addr & ~3) == 0x50) {
        if (CR_FMODE(s->regs[R_CR]) == FMODE_POLL) {
            return s->regs[R_DR] >> ((addr & 3) * 8);
        }
        v = 0;
        for (unsigned i = 0; i < size; i++) {
            if (s->fifo_pos < s->fifo_len) {
                v |= s->fifo[s->fifo_pos++] << (i * 8);
            }
        }
        if (s->fifo_pos >= s->fifo_len) {
            s->regs[R_SR] &= ~SR_FTF;
        }
        return v;
    }

    v = s->regs[addr / 4];
    if (addr / 4 != R_SR) {
        qemu_log_mask(LOG_UNIMP, "octospi1: read  0x%03x -> 0x%08x\n",
                      (unsigned)(addr & ~3), v);
    }
    if (addr / 4 == R_SR) {
        uint32_t level = s->fifo_len - s->fifo_pos;
        v &= ~(SR_BUSY | 0x3f00);
        v |= MIN(level, 32) << 8;
        if (level) {
            v |= SR_BUSY;
        }
    }
    return v >> ((addr & 3) * 8);
}

static void ospi_write(void *opaque, hwaddr addr, uint64_t value,
                       unsigned size)
{
    GnwOspiState *s = opaque;
    int idx = addr / 4;

    if ((addr & ~3) == 0x50) {
        if (s->wbuf) {
            for (unsigned i = 0; i < size && s->wlen < s->wexp; i++) {
                s->wbuf[s->wlen++] = value >> (i * 8);
            }
            if (s->wlen >= s->wexp) {
                flash_command_write(s, s->wbuf, s->wlen);
                g_clear_pointer(&s->wbuf, g_free);
                s->regs[R_SR] = (s->regs[R_SR] & ~SR_FTF) | SR_TCF;
                ospi_update_irq(s);
            }
        }
        return;
    }
    if (size != 4) {
        unsigned shift = (addr & 3) * 8;
        uint32_t mask = ((1u << (size * 8)) - 1) << shift;
        value = (s->regs[idx] & ~mask) | ((value << shift) & mask);
        addr &= ~3;
    }
    qemu_log_mask(LOG_UNIMP, "octospi1: write 0x%03x <- 0x%08x\n",
                  idx * 4, (uint32_t)value);

    switch (idx) {
    case R_SR:
        return;
    case R_FCR:
        s->regs[R_SR] &= ~(value & 0x1b);
        ospi_update_irq(s);
        return;
    case R_CR:
        if (value & 2) {        /* ABORT */
            value &= ~2;
            s->fifo_len = s->fifo_pos = 0;
            g_clear_pointer(&s->wbuf, g_free);
            s->regs[R_SR] = (s->regs[R_SR] & ~(SR_FTF | SR_SMF)) | SR_TCF;
        }
        s->regs[idx] = value;
        ospi_update_irq(s);
        return;
    }

    s->regs[idx] = value;
    if (!(s->regs[R_CR] & 1)) {
        return;
    }
    /*
     * The transfer starts on the write to the last register the command
     * format needs: IR if there is no address, AR otherwise. In write
     * mode with a data phase it completes when DR has received DLR+1 bytes.
     */
    if (idx == R_IR && !CCR_ADMODE(s->regs[R_CCR])) {
        ospi_start(s);
    } else if (idx == R_AR && CCR_ADMODE(s->regs[R_CCR])) {
        ospi_start(s);
    }
}

static const MemoryRegionOps ospi_ops = {
    .read = ospi_read,
    .write = ospi_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
};

void gnw_ospi_load(GnwOspiState *s, const uint8_t *data, uint32_t size,
                   const char *overlay)
{
    s->flash_size = pow2ceil(size);
    s->flash = g_malloc(s->flash_size);
    memset(s->flash, 0xff, s->flash_size);
    memcpy(s->flash, data, size);
    s->overlay_path = g_strdup(overlay);

    /* MX25U8035F (1 MiB) or MX25U3232F (4 MiB) */
    s->jedec[0] = 0xc2;
    s->jedec[1] = 0x25;
    s->jedec[2] = ctz32(s->flash_size);
    s->status = 0x40;           /* QE */

    memory_region_init_rom(&s->xip, OBJECT(s), "ospi-xip", s->flash_size,
                           &error_fatal);
    memcpy(memory_region_get_ram_ptr(&s->xip), s->flash, s->flash_size);
    sysbus_init_mmio(SYS_BUS_DEVICE(s), &s->xip);
}

static void gnw_ospi_reset(DeviceState *dev)
{
    GnwOspiState *s = GNW_OSPI(dev);

    memset(s->regs, 0, sizeof(s->regs));
    memset(s->otfdec, 0, sizeof(s->otfdec));
    s->regs[0x08 / 4] = 0x00000000;
    s->fifo_len = s->fifo_pos = 0;
    g_clear_pointer(&s->wbuf, g_free);
    if (s->flash) {
        memcpy(memory_region_get_ram_ptr(&s->xip), s->flash, s->flash_size);
    }
}

static void gnw_ospi_init(Object *obj)
{
    GnwOspiState *s = GNW_OSPI(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->ospi_mmio, obj, &ospi_ops, s, "octospi1",
                          0x400);
    memory_region_init_io(&s->otfdec_mmio, obj, &otfdec_ops, s, "otfdec1",
                          0x400);
    sysbus_init_mmio(sbd, &s->ospi_mmio);
    sysbus_init_mmio(sbd, &s->otfdec_mmio);
    sysbus_init_irq(sbd, &s->irq);
}

static void gnw_ospi_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_ospi_reset);
}

static const TypeInfo gnw_ospi_info = {
    .name = TYPE_GNW_OSPI,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwOspiState),
    .instance_init = gnw_ospi_init,
    .class_init = gnw_ospi_class_init,
};

static void gnw_ospi_register_types(void)
{
    type_register_static(&gnw_ospi_info);
}

type_init(gnw_ospi_register_types)
