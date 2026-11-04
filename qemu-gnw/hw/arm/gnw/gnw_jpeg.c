/*
 * Game & Watch: hardware JPEG codec (RM0455 section 33), decode only.
 *
 * Retro-Go's cover-flow UI drives it through HAL_JPEG_Decode() in polling
 * mode: the CPU pushes the JPEG stream into DIR, polls SR and pops the
 * decoded data from DOR.  The output is what the real codec produces:
 * YCbCr 8x8 blocks grouped per MCU (Y blocks in raster order, then Cb, then
 * Cr), which DMA2D later converts with its YCbCr input mode.
 *
 * Instead of modelling the codec pipeline, the stream is collected until
 * its EOI marker and decoded in one go with libjpeg (raw, non
 * colour-converted output).  Header fields (CONFR1..7) and HPDF are set as
 * soon as the SOS marker has been seen, like the hardware header parser.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "hw/core/sysbus.h"
#include "qom/object.h"
#include <setjmp.h>
#include <jpeglib.h>
#include "gnw.h"

#define R_CONFR0    (0x00 / 4)
#define R_CONFR1    (0x04 / 4)
#define R_CONFR2    (0x08 / 4)
#define R_CONFR3    (0x0c / 4)
#define R_CONFR4    (0x10 / 4)
#define R_CR        (0x30 / 4)
#define R_SR        (0x34 / 4)
#define R_CFR       (0x38 / 4)
#define R_DIR       (0x40 / 4)
#define R_DOR       (0x44 / 4)
#define R_QMEM0     (0x50 / 4)

#define SR_IFTF     (1 << 1)
#define SR_IFNFF    (1 << 2)
#define SR_OFTF     (1 << 3)
#define SR_OFNEF    (1 << 4)
#define SR_EOCF     (1 << 5)
#define SR_HPDF     (1 << 6)
#define SR_COF      (1 << 7)

#define FIFO_TH_BYTES   (8 * 4)
#define JPEG_MAX_INPUT  (4 * 1024 * 1024)

OBJECT_DECLARE_SIMPLE_TYPE(GnwJpegState, GNW_JPEG)

struct GnwJpegState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;

    uint32_t regs[0x1000 / 4];

    bool running;               /* CONFR0.START */
    bool header_done;           /* SOS seen, CONFR* filled in */
    bool hpdf;
    bool input_done;            /* EOI seen */
    bool eocf;

    /* Input stream and incremental marker parser state. */
    uint8_t *in;
    size_t in_len;
    size_t parse_pos;           /* next marker to look at (header phase) */
    bool in_scan;               /* inside entropy-coded data */

    uint8_t *out;
    size_t out_len, out_pos;
};

/* ------------------------------------------------------------------ */
/* Decoding with libjpeg                                               */

struct jerr {
    struct jpeg_error_mgr pub;
    jmp_buf jb;
};

static void jerr_exit(j_common_ptr cinfo)
{
    struct jerr *e = (struct jerr *)cinfo->err;
    char msg[JMSG_LENGTH_MAX];

    cinfo->err->format_message(cinfo, msg);
    qemu_log_mask(LOG_GUEST_ERROR, "gnw-jpeg: %s\n", msg);
    longjmp(e->jb, 1);
}

static void jerr_silent(j_common_ptr cinfo, int level)
{
}

/*
 * Decode s->in into MCU-ordered YCbCr blocks.  Returns false on error
 * (the codec then simply produces no output).
 */
static bool jpeg_decode_mcus(GnwJpegState *s)
{
    struct jpeg_decompress_struct ci;
    struct jerr err;
    JSAMPARRAY planes[MAX_COMPONENTS] = { 0 };
    int plane_lines[MAX_COMPONENTS] = { 0 };
    JSAMPIMAGE rows = NULL;
    int nc, hmax, vmax, mcux, mcuy, blocks = 0;
    size_t pos = 0;
    bool ok = false;

    memset(&ci, 0, sizeof(ci));
    ci.err = jpeg_std_error(&err.pub);
    err.pub.error_exit = jerr_exit;
    err.pub.emit_message = jerr_silent;
    if (setjmp(err.jb)) {
        goto out;
    }
    jpeg_create_decompress(&ci);
    jpeg_mem_src(&ci, s->in, s->in_len);
    jpeg_read_header(&ci, TRUE);
    ci.raw_data_out = TRUE;
    ci.out_color_space = ci.jpeg_color_space;
    ci.dct_method = JDCT_ISLOW;
    jpeg_start_decompress(&ci);

    nc = ci.num_components;
    hmax = ci.max_h_samp_factor;
    vmax = ci.max_v_samp_factor;
    mcux = DIV_ROUND_UP(ci.image_width, hmax * DCTSIZE);
    mcuy = DIV_ROUND_UP(ci.image_height, vmax * DCTSIZE);
    for (int c = 0; c < nc; c++) {
        blocks += ci.comp_info[c].h_samp_factor * ci.comp_info[c].v_samp_factor;
    }
    s->out_len = (size_t)mcux * mcuy * blocks * 64;
    s->out = g_malloc0(s->out_len);

    /* One iMCU row per component, padded to whole MCUs horizontally. */
    rows = g_new0(JSAMPARRAY, nc);
    for (int c = 0; c < nc; c++) {
        jpeg_component_info *ce = &ci.comp_info[c];
        int lines = ce->v_samp_factor * DCTSIZE;
        int width = mcux * ce->h_samp_factor * DCTSIZE;

        planes[c] = g_new0(JSAMPROW, lines);
        plane_lines[c] = lines;
        for (int l = 0; l < lines; l++) {
            planes[c][l] = g_malloc0(width);
        }
        rows[c] = planes[c];
    }

    for (int my = 0; my < mcuy; my++) {
        jpeg_read_raw_data(&ci, rows, vmax * DCTSIZE);
        /* Replicate the last decoded column into the MCU padding. */
        for (int c = 0; c < nc; c++) {
            jpeg_component_info *ce = &ci.comp_info[c];
            int have = ce->width_in_blocks * DCTSIZE;
            int width = mcux * ce->h_samp_factor * DCTSIZE;

            for (int l = 0; l < ce->v_samp_factor * DCTSIZE; l++) {
                for (int x = have; x < width; x++) {
                    planes[c][l][x] = planes[c][l][have - 1];
                }
            }
        }
        for (int mx = 0; mx < mcux; mx++) {
            for (int c = 0; c < nc; c++) {
                jpeg_component_info *ce = &ci.comp_info[c];

                for (int by = 0; by < ce->v_samp_factor; by++) {
                    for (int bx = 0; bx < ce->h_samp_factor; bx++) {
                        int x0 = (mx * ce->h_samp_factor + bx) * DCTSIZE;

                        for (int r = 0; r < DCTSIZE; r++) {
                            memcpy(s->out + pos,
                                   planes[c][by * DCTSIZE + r] + x0, DCTSIZE);
                            pos += DCTSIZE;
                        }
                    }
                }
            }
        }
    }
    jpeg_finish_decompress(&ci);
    ok = true;

out:
    jpeg_destroy_decompress(&ci);
    for (int c = 0; c < MAX_COMPONENTS; c++) {
        if (planes[c]) {
            for (int l = 0; l < plane_lines[c]; l++) {
                g_free(planes[c][l]);
            }
            g_free(planes[c]);
        }
    }
    g_free(rows);
    if (!ok) {
        g_free(s->out);
        s->out = NULL;
        s->out_len = 0;
    }
    return ok;
}

/* ------------------------------------------------------------------ */
/* Header parsing (fills CONFR1..7 like the hardware header processor)  */

static void jpeg_parse_sof(GnwJpegState *s, const uint8_t *p, size_t len)
{
    int h = (p[1] << 8) | p[2], w = (p[3] << 8) | p[4], nc = p[5];
    int hmax = 1, vmax = 1;

    if (len < 6 + 3 * (size_t)nc || nc < 1 || nc > 4) {
        return;
    }
    for (int c = 0; c < nc; c++) {
        hmax = MAX(hmax, p[7 + 3 * c] >> 4);
        vmax = MAX(vmax, p[7 + 3 * c] & 0xf);
    }
    s->regs[R_CONFR1] = (s->regs[R_CONFR1] & 0x0108) | (nc - 1) |
                        ((nc == 3 ? 1 : nc == 4 ? 3 : 0) << 4) |
                        ((uint32_t)h << 16);
    s->regs[R_CONFR3] = (uint32_t)w << 16;
    s->regs[R_CONFR2] = DIV_ROUND_UP(w, hmax * 8) * DIV_ROUND_UP(h, vmax * 8)
                        - 1;
    for (int c = 0; c < 4; c++) {
        uint32_t v = 0;

        if (c < nc) {
            int hs = p[7 + 3 * c] >> 4, vs = p[7 + 3 * c] & 0xf;

            v = ((hs * vs - 1) << 4) | ((p[8 + 3 * c] & 3) << 2) |
                (vs << 8) | (hs << 12);
        }
        s->regs[R_CONFR4 + c] = v;
    }
}

static void jpeg_parse_dqt(GnwJpegState *s, const uint8_t *p, size_t len)
{
    size_t i = 0;

    while (i + 65 <= len) {
        int pq = p[i] >> 4, tq = p[i] & 3;

        if (pq) {               /* 16-bit tables: not supported by the HW */
            return;
        }
        memcpy((uint8_t *)&s->regs[R_QMEM0 + tq * 16], p + i + 1, 64);
        i += 65;
    }
}

/* Walk the marker segments that are complete; stop at SOS or EOI. */
static void jpeg_parse_headers(GnwJpegState *s)
{
    while (!s->in_scan && !s->input_done) {
        size_t p = s->parse_pos;
        uint8_t m;
        size_t seglen;

        while (p < s->in_len && s->in[p] != 0xff) {
            p++;                /* skip garbage before a marker */
        }
        while (p + 1 < s->in_len && s->in[p + 1] == 0xff) {
            p++;                /* fill bytes */
        }
        if (p + 1 >= s->in_len) {
            s->parse_pos = p;
            return;
        }
        m = s->in[p + 1];
        if (m == 0xd8 || (m >= 0xd0 && m <= 0xd7) || m == 0x01) {
            s->parse_pos = p + 2;
            continue;
        }
        if (m == 0xd9) {
            s->parse_pos = p + 2;
            s->input_done = true;
            return;
        }
        if (p + 3 >= s->in_len) {
            s->parse_pos = p;
            return;
        }
        seglen = (s->in[p + 2] << 8) | s->in[p + 3];
        if (p + 2 + seglen > s->in_len) {
            s->parse_pos = p;
            return;
        }
        if (m == 0xc0 || m == 0xc1) {
            jpeg_parse_sof(s, s->in + p + 4, seglen - 2);
        } else if (m == 0xdb) {
            jpeg_parse_dqt(s, s->in + p + 4, seglen - 2);
        } else if (m == 0xda) {
            s->regs[R_CONFR1] = (s->regs[R_CONFR1] & ~0xc0) |
                                (((s->in[p + 4] - 1) & 3) << 6);
            s->in_scan = true;
            s->header_done = true;
            if (s->regs[R_CONFR1] & (1 << 8)) {    /* HDR */
                s->hpdf = true;
            }
        }
        s->parse_pos = p + 2 + seglen;
    }
}

/* Inside the scan: look for a marker that is not stuffing or RSTn. */
static void jpeg_scan_for_eoi(GnwJpegState *s)
{
    size_t p = s->parse_pos;

    for (; p + 1 < s->in_len; p++) {
        uint8_t m;

        if (s->in[p] != 0xff) {
            continue;
        }
        m = s->in[p + 1];
        if (m == 0x00 || m == 0xff || (m >= 0xd0 && m <= 0xd7)) {
            continue;
        }
        if (m == 0xd9) {
            s->input_done = true;
            s->in_len = p + 2;
            break;
        }
        /* Another marker (e.g. DNL, or a second scan): keep scanning. */
    }
    s->parse_pos = p;
}

static void jpeg_input_byte_ready(GnwJpegState *s)
{
    if (!s->in_scan) {
        jpeg_parse_headers(s);
    }
    if (s->in_scan && !s->input_done) {
        jpeg_scan_for_eoi(s);
    }
    if (s->input_done && !s->out) {
        jpeg_decode_mcus(s);
        s->out_pos = 0;
    }
}

static void jpeg_flush(GnwJpegState *s)
{
    g_free(s->out);
    s->out = NULL;
    s->out_len = s->out_pos = 0;
    s->in_len = 0;
    s->parse_pos = 0;
    s->in_scan = false;
    s->header_done = false;
    s->input_done = false;
}

static uint32_t jpeg_sr(GnwJpegState *s)
{
    uint32_t sr = 0;
    size_t left = s->out_len - s->out_pos;

    if (s->running && !s->input_done) {
        sr |= SR_IFTF | SR_IFNFF;
    }
    if (s->out && left >= FIFO_TH_BYTES) {
        sr |= SR_OFTF;
    }
    if (s->out && left) {
        sr |= SR_OFNEF;
    }
    if (s->running && s->input_done && !left) {
        s->eocf = true;         /* last data has left the output FIFO */
    }
    if (s->eocf) {
        sr |= SR_EOCF;
    }
    if (s->hpdf) {
        sr |= SR_HPDF;
    }
    if (s->running && !s->eocf) {
        sr |= SR_COF;
    }
    return sr;
}

/* ------------------------------------------------------------------ */

static uint64_t gnw_jpeg_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwJpegState *s = opaque;
    uint32_t v;

    switch (addr / 4) {
    case R_SR:
        return jpeg_sr(s);
    case R_CFR:
    case R_DIR:
        return 0;
    case R_DOR:
        v = 0;
        if (s->out && s->out_pos + 4 <= s->out_len) {
            v = ldl_le_p(s->out + s->out_pos);
            s->out_pos += 4;
        }
        return v;
    default:
        return s->regs[addr / 4];
    }
}

static void gnw_jpeg_write(void *opaque, hwaddr addr, uint64_t value,
                           unsigned size)
{
    GnwJpegState *s = opaque;
    int idx = addr / 4;

    switch (idx) {
    case R_CONFR0:
        s->regs[idx] = value & 1;
        if ((value & 1) && !s->running) {
            jpeg_flush(s);
            s->eocf = false;
            s->running = true;
        } else if (!(value & 1)) {
            s->running = false;
        }
        break;
    case R_CR:
        s->regs[idx] = value & 0x7f;    /* IFF/OFF are self-clearing */
        if (value & (1 << 13)) {
            s->in_len = 0;
            s->parse_pos = 0;
        }
        if (value & (1 << 14)) {
            s->out_pos = s->out_len;
        }
        break;
    case R_SR:
        break;
    case R_CFR:
        if (value & SR_EOCF) {
            s->eocf = false;
            if (s->input_done && s->out_pos >= s->out_len) {
                s->running = false;     /* codec idle until next START */
            }
        }
        if (value & SR_HPDF) {
            s->hpdf = false;
        }
        break;
    case R_DIR:
        if (!s->running || s->input_done) {
            break;
        }
        if (s->in_len + 4 > JPEG_MAX_INPUT) {
            qemu_log_mask(LOG_GUEST_ERROR, "gnw-jpeg: input too large\n");
            s->input_done = true;
            break;
        }
        stl_le_p(s->in + s->in_len, value);
        s->in_len += 4;
        jpeg_input_byte_ready(s);
        break;
    case R_DOR:
        break;
    default:
        s->regs[idx] = value;
        break;
    }
}

static const MemoryRegionOps gnw_jpeg_ops = {
    .read = gnw_jpeg_read,
    .write = gnw_jpeg_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gnw_jpeg_reset(DeviceState *dev)
{
    GnwJpegState *s = GNW_JPEG(dev);

    memset(s->regs, 0, sizeof(s->regs));
    jpeg_flush(s);
    s->running = s->hpdf = s->eocf = false;
}

static void gnw_jpeg_init(Object *obj)
{
    GnwJpegState *s = GNW_JPEG(obj);

    memory_region_init_io(&s->mmio, obj, &gnw_jpeg_ops, s, "jpeg", 0x1000);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->mmio);
    s->in = g_malloc(JPEG_MAX_INPUT);
}

static void gnw_jpeg_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_jpeg_reset);
}

static const TypeInfo gnw_jpeg_info = {
    .name = TYPE_GNW_JPEG,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwJpegState),
    .instance_init = gnw_jpeg_init,
    .class_init = gnw_jpeg_class_init,
};

static void gnw_jpeg_register(void)
{
    type_register_static(&gnw_jpeg_info);
}

type_init(gnw_jpeg_register)
