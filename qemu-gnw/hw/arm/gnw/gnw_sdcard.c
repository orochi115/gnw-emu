/*
 * Game & Watch: microSD card of the Retro-Go SD mod, in SPI mode.
 *
 * QEMU's sd-card-spi lacks CMD18/CMD25, which Retro-Go uses (with
 * ACMD23), so this is a small SPI-mode card of its own: an SDHC/SDXC card
 * (block addressed, CCS set) backed by -drive if=sd.  Command CRCs are
 * not checked (Retro-Go sends 0x01 for everything but CMD0/CMD8); data
 * blocks carry a correct CRC16.  Writes complete with a short busy.
 *
 * Two wirings exist (Retro-Go probes them in this order):
 *   spi1: SPI1 (PB3/PB4/PD7), CS on PB9 (active low), card power on PA15
 *   ospi: bit-banged over the external flash pins (Yota9's mod):
 *         CLK PB2, MOSI PB1 (IO0), MISO PD12 (IO1), card selected while
 *         the flash nCS PE11 is high; card always powered
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/units.h"
#include "qemu/error-report.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "hw/core/qdev-properties.h"
#include "hw/core/qdev-properties-system.h"
#include "system/block-backend.h"
#include "gnw.h"

#define R1_IDLE         0x01
#define R1_ILLEGAL      0x04
#define R1_ADDR_ERR     0x20
#define R1_PARAM_ERR    0x40

enum { ST_CMD, ST_WR_TOKEN, ST_WR_DATA };

static uint16_t crc16_ccitt(const uint8_t *p, size_t n)
{
    uint16_t crc = 0;

    while (n--) {
        crc ^= (uint16_t)*p++ << 8;
        for (int i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
        }
    }
    return crc;
}

static void q_reset(GnwSdState *s)
{
    s->out_len = s->out_pos = 0;
}

static void q_push(GnwSdState *s, uint8_t b)
{
    if (s->out_len < sizeof(s->out)) {
        s->out[s->out_len++] = b;
    }
}

/* Data block: a gap byte, the start token, payload, CRC16. */
static void q_block(GnwSdState *s, const uint8_t *data, size_t n)
{
    uint16_t crc = crc16_ccitt(data, n);

    q_push(s, 0xff);
    q_push(s, 0xfe);
    for (size_t i = 0; i < n; i++) {
        q_push(s, data[i]);
    }
    q_push(s, crc >> 8);
    q_push(s, crc);
}

static bool sd_read_block(GnwSdState *s, uint32_t lba)
{
    uint8_t buf[512];

    if (lba >= s->sectors ||
        blk_pread(s->blk, (int64_t)lba * 512, 512, buf, 0) < 0) {
        return false;
    }
    q_block(s, buf, 512);
    s->reads++;
    return true;
}

static void sd_write_block(GnwSdState *s)
{
    int ret = -EINVAL;
    bool ok;

    if (s->wr_lba < s->sectors && !s->read_only) {
        ret = blk_pwrite(s->blk, (int64_t)s->wr_lba * 512, 512, s->wbuf, 0);
    }
    ok = ret >= 0;

    if (s->trace) {
        qemu_log("gnw-sdcard: write lba 0x%x %s (%d%s)\n", s->wr_lba,
                 ok ? "ok" : "FAILED", ret, s->read_only ? ", read-only" : "");
    }
    /* Data response (xxx0sss1: 010 accepted, 110 write error), then busy. */
    q_reset(s);
    q_push(s, ok ? 0xe5 : 0xed);
    q_push(s, 0x00);
    q_push(s, 0x00);
    s->writes++;
}

static void sd_csd(GnwSdState *s, uint8_t *csd)
{
    uint32_t c_size = s->sectors / 1024 - 1;      /* units of 512 KiB */
    static const uint8_t tmpl[16] = {
        0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00, 0x00,
        0x00, 0x00, 0x7f, 0x80, 0x0a, 0x40, 0x00, 0x01,
    };

    memcpy(csd, tmpl, 16);
    csd[7] = (c_size >> 16) & 0x3f;
    csd[8] = c_size >> 8;
    csd[9] = c_size;
}

static void sd_command(GnwSdState *s)
{
    int cmd = s->cmd[0] & 0x3f;
    uint32_t arg = ldl_be_p(&s->cmd[1]);
    bool app = s->app;
    uint8_t r1;

    s->app = false;
    if (s->trace) {
        qemu_log("gnw-sdcard: %sCMD%d 0x%08x\n", app ? "A" : "", cmd, arg);
    }
    q_reset(s);
    s->rd_multi = false;
    q_push(s, 0xff);                    /* NCR */
    r1 = s->idle ? R1_IDLE : 0;

    if (cmd == 12) {                    /* stuff byte, then R1 (then busy) */
        q_push(s, r1);
        return;
    }
    if (s->idle && cmd != 0 && cmd != 1 && cmd != 8 && cmd != 55 &&
        cmd != 58 && cmd != 59 && !(app && cmd == 41)) {
        q_push(s, r1 | R1_ILLEGAL);
        return;
    }
    if (app) {
        switch (cmd) {
        case 41:                        /* SD_SEND_OP_COND */
            s->idle = false;
            q_push(s, 0);
            return;
        case 23:                        /* SET_WR_BLK_ERASE_COUNT */
            q_push(s, r1);
            return;
        case 13: {                      /* SD_STATUS: R2 + 64-byte block */
            uint8_t st[64] = { 0 };
            q_push(s, r1);
            q_push(s, 0);
            q_block(s, st, sizeof(st));
            return;
        }
        case 51: {                      /* SCR: SD 3.0, 1/4-bit bus */
            static const uint8_t scr[8] = { 0x02, 0x35, 0x80, 0x03 };
            q_push(s, r1);
            q_block(s, scr, sizeof(scr));
            return;
        }
        }
    }
    switch (cmd) {
    case 0:                             /* GO_IDLE_STATE */
        s->idle = true;
        s->state = ST_CMD;
        q_push(s, R1_IDLE);
        break;
    case 1:                             /* SEND_OP_COND (MMC) */
        s->idle = false;
        q_push(s, 0);
        break;
    case 8:                             /* SEND_IF_COND: echo VHS + pattern */
        q_push(s, r1);
        q_push(s, 0x00);
        q_push(s, 0x00);
        q_push(s, (arg >> 8) & 0x0f);
        q_push(s, arg & 0xff);
        break;
    case 9:
    case 10: {                          /* SEND_CSD / SEND_CID */
        uint8_t reg[16];
        static const uint8_t cid[16] = {
            0x03, 'S', 'D', 'G', 'N', 'W', 'E', 'M',
            0x10, 0x12, 0x34, 0x56, 0x78, 0x01, 0x8b, 0x01,
        };
        if (cmd == 9) {
            sd_csd(s, reg);
        } else {
            memcpy(reg, cid, 16);
        }
        q_push(s, r1);
        q_block(s, reg, 16);
        break;
    }
    case 13:                            /* SEND_STATUS: R2 */
        q_push(s, r1);
        q_push(s, 0);
        break;
    case 16:                            /* SET_BLOCKLEN */
        q_push(s, arg == 512 ? r1 : r1 | R1_PARAM_ERR);
        break;
    case 17:                            /* READ_SINGLE_BLOCK */
    case 18:                            /* READ_MULTIPLE_BLOCK */
        if (arg >= s->sectors) {
            q_push(s, r1 | R1_ADDR_ERR);
            break;
        }
        q_push(s, r1);
        sd_read_block(s, arg);
        if (cmd == 18) {
            s->rd_multi = true;
            s->rd_lba = arg + 1;
        }
        break;
    case 24:                            /* WRITE_BLOCK */
    case 25:                            /* WRITE_MULTIPLE_BLOCK */
        if (arg >= s->sectors) {
            q_push(s, r1 | R1_ADDR_ERR);
            break;
        }
        q_push(s, r1);
        s->state = ST_WR_TOKEN;
        s->wr_multi = cmd == 25;
        s->wr_lba = arg;
        break;
    case 55:                            /* APP_CMD */
        s->app = true;
        q_push(s, r1);
        break;
    case 58:                            /* READ_OCR: powered up, CCS, 2.7-3.6V */
        q_push(s, r1);
        q_push(s, (s->idle ? 0 : 0x80) | 0x40);
        q_push(s, 0xff);
        q_push(s, 0x80);
        q_push(s, 0x00);
        break;
    case 59:                            /* CRC_ON_OFF */
        q_push(s, r1);
        break;
    default:
        qemu_log_mask(LOG_UNIMP, "gnw-sdcard: %sCMD%d 0x%08x unsupported\n",
                      app ? "A" : "", cmd, arg);
        q_push(s, r1 | R1_ILLEGAL);
        break;
    }
}

/* The byte the card shifts out while the host shifts the next one in. */
static uint8_t sd_out_byte(GnwSdState *s)
{
    if (s->out_pos >= s->out_len) {
        q_reset(s);
        if (s->rd_multi) {
            if (!sd_read_block(s, s->rd_lba++)) {
                s->rd_multi = false;
            }
        }
        if (s->out_pos >= s->out_len) {
            return 0xff;
        }
    }
    return s->out[s->out_pos++];
}

static void sd_in_byte(GnwSdState *s, uint8_t in)
{
    switch (s->state) {
    case ST_WR_DATA:
        s->wbuf[s->wpos++] = in;
        if (s->wpos == sizeof(s->wbuf)) {          /* 512 data + CRC16 */
            sd_write_block(s);
            if (s->wr_multi) {
                s->wr_lba++;
                s->state = ST_WR_TOKEN;
            } else {
                s->state = ST_CMD;
            }
        }
        return;
    case ST_WR_TOKEN:
        if (s->trace && in != 0xff) {
            qemu_log("gnw-sdcard: token 0x%02x\n", in);
        }
        if ((in == 0xfe && !s->wr_multi) || (in == 0xfc && s->wr_multi)) {
            s->state = ST_WR_DATA;
            s->wpos = 0;
            return;
        }
        if (in == 0xfd && s->wr_multi) {           /* stop tran: busy */
            s->state = ST_CMD;
            q_reset(s);
            q_push(s, 0xff);
            q_push(s, 0x00);
            q_push(s, 0x00);
            return;
        }
        if ((in & 0xc0) != 0x40) {
            return;
        }
        s->state = ST_CMD;
        /* fall through: a command aborts the write */
    case ST_CMD:
        if (s->cmd_len == 0 && (in & 0xc0) != 0x40) {
            return;
        }
        s->cmd[s->cmd_len++] = in;
        if (s->cmd_len == 6) {
            s->cmd_len = 0;
            sd_command(s);
        }
        return;
    }
}

static bool sd_active(GnwSdState *s)
{
    return s->blk && s->powered && s->selected;
}

static void sd_power(GnwSdState *s, bool on)
{
    if (on && !s->powered) {
        s->idle = true;
        s->app = false;
        s->state = ST_CMD;
        s->cmd_len = 0;
        s->rd_multi = false;
        q_reset(s);
    }
    s->powered = on;
}

static void sd_select(GnwSdState *s, bool sel)
{
    if (sel != s->selected) {
        s->cmd_len = 0;
        s->bit = 0;
    }
    s->selected = sel;
}

/* SPI1 byte exchange. */
static uint8_t sd_spi1_xfer(void *opaque, uint8_t in)
{
    GnwSdState *s = opaque;
    uint8_t out;

    if (s->ospi_wiring || !sd_active(s)) {
        return 0xff;
    }
    out = sd_out_byte(s);
    sd_in_byte(s, in);
    return out;
}

/* ---- spi1 wiring: PA15 power, PB9 CS (active low) ---- */

static void sd_vcc_in(void *opaque, int n, int level)
{
    GnwSdState *s = opaque;

    if (!s->ospi_wiring) {
        sd_power(s, level);
    }
}

static void sd_cs_in(void *opaque, int n, int level)
{
    GnwSdState *s = opaque;

    if (!s->ospi_wiring) {
        sd_select(s, !level);
    }
}

/* ---- ospi wiring: bit-banged mode 0 on the flash pins ---- */

static void sd_bb_miso(GnwSdState *s, bool level)
{
    if (s->gpio) {
        gnw_gpio_set_external(s->gpio, 3, 12, level);  /* PD12 */
    }
}

static void sd_bb_in(void *opaque, int n, int level)
{
    GnwSdState *s = opaque;

    if (!s->ospi_wiring) {
        return;
    }
    switch (n) {
    case 0:                             /* CLK, PB2 */
        if (level && !s->bb_clk && sd_active(s)) {
            if (s->bit == 0) {
                s->bb_out = sd_out_byte(s);
            }
            sd_bb_miso(s, (s->bb_out >> (7 - s->bit)) & 1);
            s->bb_in = (s->bb_in << 1) | s->bb_mosi;
            if (++s->bit == 8) {
                s->bit = 0;
                sd_in_byte(s, s->bb_in);
            }
        }
        s->bb_clk = level;
        break;
    case 1:                             /* MOSI, PB1 */
        s->bb_mosi = level;
        break;
    case 2:                             /* flash nCS, PE11: high selects */
        sd_select(s, level);
        if (!level) {
            sd_bb_miso(s, true);
        }
        break;
    }
}

static void gnw_sdcard_reset(DeviceState *dev)
{
    GnwSdState *s = GNW_SDCARD(dev);

    s->powered = false;
    sd_power(s, s->ospi_wiring);
    s->selected = false;
    s->bit = 0;
    s->bb_clk = false;
}

static void gnw_sdcard_realize(DeviceState *dev, Error **errp)
{
    GnwSdState *s = GNW_SDCARD(dev);
    int64_t len;

    if (!s->blk) {
        return;
    }
    s->read_only = !blk_supports_write_perm(s->blk);
    if (blk_set_perm(s->blk, BLK_PERM_CONSISTENT_READ |
                     (s->read_only ? 0 : BLK_PERM_WRITE),
                     BLK_PERM_ALL, errp) < 0) {
        return;
    }
    len = blk_getlength(s->blk);
    if (len < 0 || len % (512 * KiB)) {
        error_setg(errp, "gnw-sdcard: image size must be a multiple of "
                   "512 KiB");
        return;
    }
    s->sectors = len / 512;
    info_report("gnw: SD card %" PRId64 " MiB on %s", len / MiB,
                s->ospi_wiring ? "the OSPI pins (bit-banged)" : "SPI1");
}

static void gnw_sdcard_init(Object *obj)
{
    GnwSdState *s = GNW_SDCARD(obj);
    DeviceState *dev = DEVICE(obj);

    qdev_init_gpio_in_named(dev, sd_vcc_in, "vcc", 1);
    qdev_init_gpio_in_named(dev, sd_cs_in, "cs", 1);
    qdev_init_gpio_in_named(dev, sd_bb_in, "bitbang", 3);
    (void)s;
}

uint8_t gnw_sdcard_spi_xfer(void *opaque, uint8_t in)
{
    return sd_spi1_xfer(opaque, in);
}

static const Property gnw_sdcard_props[] = {
    DEFINE_PROP_DRIVE("drive", GnwSdState, blk),
    DEFINE_PROP_BOOL("ospi-wiring", GnwSdState, ospi_wiring, false),
    DEFINE_PROP_BOOL("trace", GnwSdState, trace, false),
};

static void gnw_sdcard_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->realize = gnw_sdcard_realize;
    device_class_set_legacy_reset(dc, gnw_sdcard_reset);
    device_class_set_props(dc, gnw_sdcard_props);
}

static const TypeInfo gnw_sdcard_info = {
    .name = TYPE_GNW_SDCARD,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwSdState),
    .instance_init = gnw_sdcard_init,
    .class_init = gnw_sdcard_class_init,
};

static void gnw_sdcard_register_types(void)
{
    type_register_static(&gnw_sdcard_info);
}

type_init(gnw_sdcard_register_types)
