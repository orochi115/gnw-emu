/*
 * Game & Watch: embedded flash, both banks, and the FLASH interface
 * (RM0455 section 4) with programming and sector erase.
 *
 * The banks are ROM devices: reads go straight to RAM, stores reach
 * flash_bank_write().  With CRx.PG set, stores collect into a 128-bit
 * flash word which is programmed (AND-ed) once all 16 bytes are there,
 * as HAL_FLASH_Program() does with four word stores.  CRx.SER|START erases
 * one 8 KiB sector, BER|START the whole bank.  Nothing is ever busy.
 *
 * With an overlay file per bank, every change is written back, so the
 * Retro-Go SD update path (bootloader -> firmware_update -> bank 2) leaves
 * the new firmware on disk like it would on the device.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/units.h"
#include "qemu/error-report.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "gnw.h"

#define SECTOR_SIZE     (8 * KiB)

#define R_ACR           (0x00 / 4)
#define R_KEYR          (0x04 / 4)
#define R_CR            (0x0c / 4)
#define R_SR            (0x10 / 4)
#define R_CCR           (0x14 / 4)
#define R_OPTSR_CUR     (0x1c / 4)
#define R_OPTSR_PRG     (0x20 / 4)

#define CR_LOCK         (1 << 0)
#define CR_PG           (1 << 1)
#define CR_SER          (1 << 2)
#define CR_BER          (1 << 3)
#define CR_START        (1 << 5)

#define SR_WBNE         (1 << 1)
#define SR_QW           (1 << 2)
#define SR_EOP          (1 << 16)
#define SR_WRPERR       (1 << 17)
#define SR_PGSERR       (1 << 18)
#define SR_ERRORS       0x0fee0000

#define KEY1            0x45670123
#define KEY2            0xcdef89ab

static uint32_t *bank_reg(GnwFlashState *s, int b, int r)
{
    return &s->regs[r + b * (0x100 / 4)];
}

static void flash_persist(GnwFlashState *s, int b, uint32_t off,
                          uint32_t len)
{
    uint8_t *p = memory_region_get_ram_ptr(&s->bank[b]);

    memory_region_flush_rom_device(&s->bank[b], off, len);
    if (s->fd[b] >= 0 && pwrite(s->fd[b], p + off, len, off) != len) {
        warn_report("gnw: bank %d overlay write failed", b + 1);
    }
}

static void flash_erase(GnwFlashState *s, int b, uint32_t off, uint32_t len)
{
    uint8_t *p = memory_region_get_ram_ptr(&s->bank[b]);

    if (off >= s->size[b]) {
        return;
    }
    len = MIN(len, s->size[b] - off);
    memset(p + off, 0xff, len);
    flash_persist(s, b, off, len);
    qemu_log_mask(LOG_UNIMP, "gnw-flash: bank %d erase 0x%06x +0x%x\n",
                  b + 1, off, len);
}

static void flash_bank_write(void *opaque, hwaddr addr, uint64_t value,
                             unsigned size, int b)
{
    GnwFlashState *s = opaque;
    uint32_t cr = *bank_reg(s, b, R_CR);
    uint32_t word = addr & ~15;
    uint8_t *p;

    if ((cr & CR_LOCK) || !(cr & CR_PG)) {
        qemu_log_mask(LOG_GUEST_ERROR, "gnw-flash: bank %d store at 0x%06"
                      HWADDR_PRIx " without PG\n", b + 1, addr);
        *bank_reg(s, b, R_SR) |= (cr & CR_LOCK) ? SR_WRPERR : SR_PGSERR;
        return;
    }
    if (s->wmask[b] && s->waddr[b] != word) {
        *bank_reg(s, b, R_SR) |= SR_PGSERR;     /* crossed a flash word */
        s->wmask[b] = 0;
    }
    s->waddr[b] = word;
    for (unsigned i = 0; i < size; i++) {
        unsigned o = (addr & 15) + i;
        s->wbuf[b][o] = value >> (8 * i);
        s->wmask[b] |= 1 << o;
    }
    if (s->wmask[b] != 0xffff) {
        return;
    }
    s->wmask[b] = 0;
    if (word >= s->size[b]) {
        return;
    }
    p = memory_region_get_ram_ptr(&s->bank[b]);
    for (int i = 0; i < 16; i++) {
        p[word + i] &= s->wbuf[b][i];
    }
    flash_persist(s, b, word, 16);
    *bank_reg(s, b, R_SR) |= SR_EOP;
}

static void flash_bank1_write(void *opaque, hwaddr addr, uint64_t value,
                              unsigned size)
{
    flash_bank_write(opaque, addr, value, size, 0);
}

static void flash_bank2_write(void *opaque, hwaddr addr, uint64_t value,
                              unsigned size)
{
    flash_bank_write(opaque, addr, value, size, 1);
}

/* Only used if the region leaves ROMD mode, which never happens. */
static uint64_t flash_bank_read(void *opaque, hwaddr addr, unsigned size)
{
    return 0;
}

static const MemoryRegionOps flash_bank_ops[2] = {
    {
        .read = flash_bank_read,
        .write = flash_bank1_write,
        .endianness = DEVICE_LITTLE_ENDIAN,
        .valid.min_access_size = 1,
        .valid.max_access_size = 4,
        .impl.min_access_size = 1,
        .impl.max_access_size = 4,
    }, {
        .read = flash_bank_read,
        .write = flash_bank2_write,
        .endianness = DEVICE_LITTLE_ENDIAN,
        .valid.min_access_size = 1,
        .valid.max_access_size = 4,
        .impl.min_access_size = 1,
        .impl.max_access_size = 4,
    },
};

static uint64_t flash_if_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwFlashState *s = opaque;
    hwaddr off = addr & ~3;
    uint32_t v = s->regs[off / 4];

    if ((off & 0xff) == 0x10) {                 /* SRx */
        int b = off >= 0x100;
        v &= ~(SR_WBNE | SR_QW | 1);
        if (s->wmask[b]) {
            v |= SR_WBNE;
        }
    } else if ((off & 0xff) == 0x04) {          /* KEYRx reads 0 */
        v = 0;
    }
    return v >> ((addr & 3) * 8);
}

static void flash_if_write(void *opaque, hwaddr addr, uint64_t value,
                           unsigned size)
{
    GnwFlashState *s = opaque;
    hwaddr off = addr & ~3;
    unsigned shift = (addr & 3) * 8;
    uint32_t mask = (size == 4 ? 0xffffffffu : ((1u << (size * 8)) - 1))
                    << shift;
    uint32_t val = (s->regs[off / 4] & ~mask) |
                   (((uint32_t)value << shift) & mask);
    int b = off >= 0x100 && off < 0x200;

    switch (off) {
    case 0x04: case 0x104: {                    /* KEYRx */
        uint32_t *cr = bank_reg(s, b, R_CR);
        if (val == KEY1) {
            s->key_step[b] = 1;
        } else if (val == KEY2 && s->key_step[b] == 1) {
            *cr &= ~CR_LOCK;
            s->key_step[b] = 0;
        } else {
            s->key_step[b] = 0;                 /* real chip: bus error */
        }
        return;
    }
    case 0x0c: case 0x10c: {                    /* CRx */
        uint32_t *cr = bank_reg(s, b, R_CR);
        if (*cr & CR_LOCK) {
            return;
        }
        *cr = val & ~CR_START;
        if (val & CR_START) {
            if (val & CR_BER) {
                flash_erase(s, b, 0, s->size[b]);
            } else if (val & CR_SER) {
                flash_erase(s, b, extract32(val, 6, 7) * SECTOR_SIZE,
                            SECTOR_SIZE);
            }
            *bank_reg(s, b, R_SR) |= SR_EOP;
        }
        if (!(val & CR_PG)) {
            s->wmask[b] = 0;
        }
        return;
    }
    case 0x10: case 0x110:                      /* SRx: read only */
        return;
    case 0x14: case 0x114:                      /* CCRx */
        *bank_reg(s, b, R_SR) &= ~(val & (SR_ERRORS | SR_EOP));
        return;
    }
    s->regs[off / 4] = val;
    qemu_log_mask(LOG_UNIMP, "gnw-flash: write 0x%03" HWADDR_PRIx
                  " <- 0x%08x\n", off, val);
}

static const MemoryRegionOps flash_if_ops = {
    .read = flash_if_read,
    .write = flash_if_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
    .impl.min_access_size = 1,
    .impl.max_access_size = 4,
};

void gnw_flash_load(GnwFlashState *s, int b, const uint8_t *data,
                    size_t len, uint32_t size, const char *overlay)
{
    uint8_t *p;

    s->size[b] = size;
    memory_region_init_rom_device(&s->bank[b], OBJECT(s), &flash_bank_ops[b],
                                  s, b ? "flash-bank2" : "flash", size,
                                  &error_fatal);
    p = memory_region_get_ram_ptr(&s->bank[b]);
    memset(p, 0xff, size);
    s->fd[b] = -1;
    if (overlay && g_file_test(overlay, G_FILE_TEST_EXISTS)) {
        gchar *ov;
        gsize ov_len;

        if (!g_file_get_contents(overlay, &ov, &ov_len, NULL)) {
            error_report("gnw: cannot read %s", overlay);
            exit(1);
        }
        memcpy(p, ov, MIN(ov_len, size));
        g_free(ov);
    } else if (data) {
        memcpy(p, data, MIN(len, size));
    }
    if (overlay) {
        s->fd[b] = open(overlay, O_RDWR | O_CREAT | O_BINARY, 0644);
        if (s->fd[b] < 0 || pwrite(s->fd[b], p, size, 0) != size) {
            error_report("gnw: cannot write %s", overlay);
            exit(1);
        }
    }
    sysbus_init_mmio(SYS_BUS_DEVICE(s), &s->bank[b]);
}

static void gnw_flash_reset(DeviceState *dev)
{
    GnwFlashState *s = GNW_FLASH(dev);

    memset(s->regs, 0, sizeof(s->regs));
    for (int b = 0; b < 2; b++) {
        *bank_reg(s, b, R_CR) = 0x00000031;     /* LOCK */
        s->key_step[b] = 0;
        s->wmask[b] = 0;
    }
    s->regs[R_OPTSR_CUR] = 0x0000aaf0;          /* RDP level 0 */
    s->regs[R_OPTSR_PRG] = 0x0000aaf0;
}

static void gnw_flash_init(Object *obj)
{
    GnwFlashState *s = GNW_FLASH(obj);

    memory_region_init_io(&s->mmio, obj, &flash_if_ops, s, "flash-if",
                          0x1000);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->mmio);
}

static void gnw_flash_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_flash_reset);
}

static const TypeInfo gnw_flash_info = {
    .name = TYPE_GNW_FLASH,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwFlashState),
    .instance_init = gnw_flash_init,
    .class_init = gnw_flash_class_init,
};

static void gnw_flash_register_types(void)
{
    type_register_static(&gnw_flash_info);
}

type_init(gnw_flash_register_types)
