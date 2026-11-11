/*
 * Game & Watch: LTDC display controller and DMA2D (Chrom-ART).
 *
 * LTDC: shadow registers are copied to the active set on SRCR.IMR or at
 * vertical blanking (SRCR.VBR). A frame timer at ~60 Hz raises the line
 * interrupt (LIPCR) and register-reload interrupt. The two layers are
 * composed over the background colour into the QEMU console.
 *
 * DMA2D: transfers run synchronously when CR.START is written.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/timer.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "system/address-spaces.h"
#include "system/dma.h"
#include "ui/console.h"
#include "ui/pixel_ops.h"
#include "gnw.h"

#define L_SSCR      (0x08 / 4)
#define L_BPCR      (0x0c / 4)
#define L_AWCR      (0x10 / 4)
#define L_TWCR      (0x14 / 4)
#define L_GCR       (0x18 / 4)
#define L_SRCR      (0x24 / 4)
#define L_BCCR      (0x2c / 4)
#define L_IER       (0x34 / 4)
#define L_ISR       (0x38 / 4)
#define L_ICR       (0x3c / 4)
#define L_LIPCR     (0x40 / 4)
#define L_CPSR      (0x44 / 4)
#define L_CDSR      (0x48 / 4)

/* layer registers, n = 0/1 */
#define LY(n, off)  ((0x84 + (n) * 0x80 + (off)) / 4)
#define LY_CR       0x00
#define LY_WHPCR    0x04
#define LY_WVPCR    0x08
#define LY_CKCR     0x0c
#define LY_PFCR     0x10
#define LY_CACR     0x14
#define LY_DCCR     0x18
#define LY_BFCR     0x1c
#define LY_CFBAR    0x28
#define LY_CFBLR    0x2c
#define LY_CFBLNR   0x30
#define LY_CLUTWR   0x40

#define ISR_LIF     (1 << 0)
#define ISR_RRIF    (1 << 3)

/* Pixel formats shared by LTDC (PF) and DMA2D (CM). */
enum {
    PF_ARGB8888, PF_RGB888, PF_RGB565, PF_ARGB1555, PF_ARGB4444,
    PF_L8, PF_AL44, PF_AL88, PF_L4, PF_A8, PF_A4,
};

static const int pf_bits[] = { 32, 24, 16, 16, 16, 8, 8, 16, 4, 8, 4 };

static uint32_t expand(uint32_t v, int bits)
{
    return bits == 8 ? v : (v << (8 - bits)) | (v >> (2 * bits - 8));
}

/* Decode pixel i (index within the line buffer) into ARGB8888. */
static uint32_t pixel_get(const uint8_t *buf, int fmt, int i,
                          const uint32_t *clut, uint32_t color)
{
    const uint8_t *p;
    uint32_t v, a, r, g, b;

    switch (fmt) {
    case PF_ARGB8888:
        return ldl_le_p(buf + i * 4);
    case PF_RGB888:
        p = buf + i * 3;
        return 0xff000000 | (p[2] << 16) | (p[1] << 8) | p[0];
    case PF_RGB565:
        v = lduw_le_p(buf + i * 2);
        r = expand(v >> 11, 5);
        g = expand((v >> 5) & 0x3f, 6);
        b = expand(v & 0x1f, 5);
        return 0xff000000 | (r << 16) | (g << 8) | b;
    case PF_ARGB1555:
        v = lduw_le_p(buf + i * 2);
        a = (v & 0x8000) ? 0xff : 0;
        r = expand((v >> 10) & 0x1f, 5);
        g = expand((v >> 5) & 0x1f, 5);
        b = expand(v & 0x1f, 5);
        return (a << 24) | (r << 16) | (g << 8) | b;
    case PF_ARGB4444:
        v = lduw_le_p(buf + i * 2);
        return (((v >> 12) & 0xf) * 0x11 << 24) | (((v >> 8) & 0xf) * 0x11 << 16)
               | (((v >> 4) & 0xf) * 0x11 << 8) | ((v & 0xf) * 0x11);
    case PF_L8:
        return clut[buf[i]];
    case PF_AL44:
        v = buf[i];
        return ((v >> 4) * 0x11 << 24) | (clut[v & 0xf] & 0xffffff);
    case PF_AL88:
        v = lduw_le_p(buf + i * 2);
        return ((v >> 8) << 24) | (clut[v & 0xff] & 0xffffff);
    case PF_L4:
        v = (buf[i / 2] >> ((i & 1) * 4)) & 0xf;
        return clut[v];
    case PF_A8:
        return (buf[i] << 24) | (color & 0xffffff);
    case PF_A4:
        v = (buf[i / 2] >> ((i & 1) * 4)) & 0xf;
        return (v * 0x11 << 24) | (color & 0xffffff);
    }
    return 0;
}

static void pixel_put(uint8_t *buf, int fmt, int i, uint32_t c)
{
    uint32_t a = c >> 24, r = (c >> 16) & 0xff, g = (c >> 8) & 0xff,
             b = c & 0xff;

    switch (fmt) {
    case PF_ARGB8888:
        stl_le_p(buf + i * 4, c);
        break;
    case PF_RGB888:
        buf[i * 3] = b;
        buf[i * 3 + 1] = g;
        buf[i * 3 + 2] = r;
        break;
    case PF_RGB565:
        stw_le_p(buf + i * 2, ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
        break;
    case PF_ARGB1555:
        stw_le_p(buf + i * 2, ((a >> 7) << 15) | ((r >> 3) << 10) |
                 ((g >> 3) << 5) | (b >> 3));
        break;
    case PF_ARGB4444:
        stw_le_p(buf + i * 2, ((a >> 4) << 12) | ((r >> 4) << 8) |
                 ((g >> 4) << 4) | (b >> 4));
        break;
    }
}

static uint32_t blend(uint32_t fg, uint32_t bg, uint32_t alpha)
{
    uint32_t out = 0;

    for (int sh = 0; sh < 24; sh += 8) {
        uint32_t f = (fg >> sh) & 0xff, b = (bg >> sh) & 0xff;
        out |= ((f * alpha + b * (255 - alpha)) / 255) << sh;
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* LTDC timing                                                          */

static int ltdc_total_lines(GnwLtdcState *s)
{
    return MAX(extract32(s->regs[L_TWCR], 0, 12) + 1, 1);
}

static int ltdc_active_end(GnwLtdcState *s)
{
    return extract32(s->regs[L_AWCR], 0, 12) + 1;
}

static void ltdc_update_irq(GnwLtdcState *s)
{
    qemu_set_irq(s->ltdc_irq, (s->regs[L_ISR] & s->regs[L_IER] & 0xf) != 0);
}

static void ltdc_reload(GnwLtdcState *s)
{
    memcpy(s->active, s->regs, sizeof(s->active));
}

static int64_t ltdc_line_ns(GnwLtdcState *s, int line)
{
    int total = ltdc_total_lines(s);

    return s->frame_start_ns + s->frame_ns * MIN(line, total) / total;
}

static void ltdc_schedule(GnwLtdcState *s)
{
    int lip = extract32(s->regs[L_LIPCR], 0, 12);
    int vbl = ltdc_active_end(s);

    if (s->phase == 0 && lip >= vbl) {
        s->phase = 1;
    }
    if (s->phase == 0) {
        timer_mod(s->frame_timer, ltdc_line_ns(s, lip));
    } else if (s->phase == 1) {
        timer_mod(s->frame_timer, ltdc_line_ns(s, vbl));
    } else {
        timer_mod(s->frame_timer, ltdc_line_ns(s, lip));
    }
}

static void ltdc_frame_tick(void *opaque)
{
    GnwLtdcState *s = opaque;
    int lip = extract32(s->regs[L_LIPCR], 0, 12);
    int vbl = ltdc_active_end(s);

    if (!(s->regs[L_GCR] & 1)) {
        return;
    }
    switch (s->phase) {
    case 0: /* line interrupt before the vertical blanking */
        s->regs[L_ISR] |= ISR_LIF;
        s->phase = 1;
        break;
    case 1: /* vertical blanking: shadow reload */
        if (s->regs[L_SRCR] & 2) {
            s->regs[L_SRCR] &= ~2;
            ltdc_reload(s);
            s->regs[L_ISR] |= ISR_RRIF;
        }
        s->frame_count++;
        s->phase = lip >= vbl ? 2 : 3;
        break;
    case 2: /* line interrupt inside the blanking */
        s->regs[L_ISR] |= ISR_LIF;
        s->phase = 3;
        break;
    }
    if (s->phase == 3) {
        int64_t now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);

        s->frame_start_ns += s->frame_ns;
        if (s->frame_start_ns + s->frame_ns < now) {
            s->frame_start_ns = now;    /* fell behind: resynchronise */
        }
        s->phase = 0;
    }
    ltdc_update_irq(s);
    ltdc_schedule(s);
}

static void ltdc_start(GnwLtdcState *s)
{
    s->frame_start_ns = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    s->phase = 0;
    ltdc_schedule(s);
}

/* ------------------------------------------------------------------ */
/* LTDC rendering                                                       */

static void ltdc_invalidate(void *opaque)
{
}

static void ltdc_render_layer(GnwLtdcState *s, int n, uint32_t *fb,
                              int w, int h)
{
    const uint32_t *a = s->active;
    uint32_t cr = a[LY(n, LY_CR)];
    int ahbp = extract32(a[L_BPCR], 16, 12), avbp = extract32(a[L_BPCR], 0, 12);
    uint32_t whpcr = a[LY(n, LY_WHPCR)], wvpcr = a[LY(n, LY_WVPCR)];
    int x0 = extract32(whpcr, 0, 12) - ahbp - 1;
    int x1 = extract32(whpcr, 16, 12) - ahbp;
    int y0 = extract32(wvpcr, 0, 11) - avbp - 1;
    int y1 = extract32(wvpcr, 16, 11) - avbp;
    int fmt = a[LY(n, LY_PFCR)] & 7;
    uint32_t addr = a[LY(n, LY_CFBAR)];
    int pitch = (int16_t)extract32(a[LY(n, LY_CFBLR)], 16, 16);
    int lines = extract32(a[LY(n, LY_CFBLNR)], 0, 11);
    uint32_t calpha = a[LY(n, LY_CACR)] & 0xff;
    uint32_t dflt = a[LY(n, LY_DCCR)];
    int bf1 = extract32(a[LY(n, LY_BFCR)], 8, 3);
    const uint32_t *clut = (cr & (1 << 4)) ? s->clut[n] : NULL;
    uint32_t lut_identity[256];
    int lw = x1 - x0;
    uint8_t *line;

    if (!(cr & 1)) {
        return;
    }
    if (!clut) {
        for (int i = 0; i < 256; i++) {
            lut_identity[i] = 0xff000000 | (i * 0x010101);
        }
        clut = lut_identity;
    } else if (fmt == PF_AL44) {
        /* LTDC widens the 4-bit index to 8 bits by replication. */
        for (int i = 0; i < 16; i++) {
            lut_identity[i] = clut[i * 0x11];
        }
        clut = lut_identity;
    }
    if (lw <= 0) {
        return;
    }
    line = g_malloc((lw * pf_bits[fmt] + 7) / 8 + 4);
    for (int y = MAX(y0, 0); y < MIN(y1, h); y++) {
        int row = y - y0;
        bool have = row < MAX(lines, 1);

        if (have) {
            dma_memory_read(&address_space_memory, addr + row * pitch, line,
                            (lw * pf_bits[fmt] + 7) / 8,
                            MEMTXATTRS_UNSPECIFIED);
        }
        for (int x = MAX(x0, 0); x < MIN(x1, w); x++) {
            uint32_t c = have ? pixel_get(line, fmt, x - x0, clut, 0) : dflt;
            uint32_t alpha = calpha;
            if (bf1 == 6) {     /* pixel alpha x constant alpha */
                alpha = (alpha * (c >> 24)) / 255;
            }
            fb[y * w + x] = blend(c, fb[y * w + x], alpha);
        }
    }
    g_free(line);
}

/* LCD supply rails: PD4 = 3.3 V enable (high), PD1 = 1.8 V enable (low). */
static bool ltdc_panel_powered(GnwLtdcState *s)
{
    return s->rail_3v3 && !s->rail_1v8_n;
}

static void ltdc_rail_in(void *opaque, int n, int level)
{
    GnwLtdcState *s = opaque;

    if (n == 0) {
        s->rail_3v3 = level;
    } else {
        s->rail_1v8_n = level;
    }
}

static uint32_t ltdc_backlight(GnwLtdcState *s)
{
    GnwGpioPort *pa = &s->gpio->port[0];
    unsigned mode = extract32(pa->moder, 4 * 2, 2);

    /* PA4 can also drive the backlight as a digital on/off output. */
    if (mode == 1) {
        return (pa->odr & (1 << 4)) ? 4095 : 0;
    }
    return mode == 3 ? gnw_dac_output(s->backlight_dac, 0) : 0;
}

static bool ltdc_update_display(void *opaque)
{
    GnwLtdcState *s = opaque;
    const uint32_t *a = s->active;
    int ahbp = extract32(a[L_BPCR], 16, 12), avbp = extract32(a[L_BPCR], 0, 12);
    int w = extract32(a[L_AWCR], 16, 12) - ahbp;
    int h = extract32(a[L_AWCR], 0, 12) - avbp;
    DisplaySurface *surface;
    uint32_t *fb;
    uint32_t brightness = ltdc_backlight(s);

    if (!(s->regs[L_GCR] & 1) || w <= 0 || h <= 0 || w > 2048 || h > 2048) {
        w = 320;
        h = 240;
    }
    if (w != s->width || h != s->height) {
        s->width = w;
        s->height = h;
        qemu_console_resize(s->con, w, h);
    }
    surface = qemu_console_surface(s->con);
    if (surface_bits_per_pixel(surface) != 32) {
        return true;
    }
    fb = g_new(uint32_t, w * h);
    for (int i = 0; i < w * h; i++) {
        fb[i] = (s->regs[L_GCR] & 1) ? (a[L_BCCR] & 0xffffff) : 0;
    }
    if (!ltdc_panel_powered(s) || !brightness) {
        memset(fb, 0, w * h * sizeof(*fb));     /* panel off: dark */
    } else if (s->regs[L_GCR] & 1) {
        ltdc_render_layer(s, 0, fb, w, h);
        ltdc_render_layer(s, 1, fb, w, h);
    }
    for (int y = 0; y < h; y++) {
        uint32_t *dst = (uint32_t *)((uint8_t *)surface_data(surface) +
                                     y * surface_stride(surface));
        for (int x = 0; x < w; x++) {
            uint32_t c = fb[y * w + x], out = 0xff000000;

            for (int sh = 0; sh < 24; sh += 8) {
                out |= (((c >> sh) & 0xff) * brightness / 4095) << sh;
            }
            dst[x] = out;
        }
    }
    g_free(fb);
    qemu_console_update(s->con, 0, 0, w, h);
    return true;
}

static const GraphicHwOps ltdc_gfx_ops = {
    .invalidate = ltdc_invalidate,
    .gfx_update = ltdc_update_display,
};

static uint64_t ltdc_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwLtdcState *s = opaque;
    int idx = addr / 4;
    int64_t now, pos;
    int total, line;

    switch (idx) {
    case L_CPSR:
    case L_CDSR:
        total = ltdc_total_lines(s);
        now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
        pos = (now - s->frame_start_ns) % MAX(s->frame_ns, 1);
        line = pos * total / MAX(s->frame_ns, 1);
        if (idx == L_CPSR) {
            return line;
        } else {
            int vsync = extract32(s->regs[L_SSCR], 0, 11);
            int avbp = extract32(s->regs[L_BPCR], 0, 12);
            int aah = extract32(s->regs[L_AWCR], 0, 12);
            uint32_t v = 0;
            if (line > avbp && line <= aah) {
                v |= 1;         /* VDES */
            }
            if (line <= vsync) {
                v |= 4;         /* VSYNCS */
            }
            return v | 2;
        }
    case L_ICR:
        return 0;
    }
    return s->regs[idx];
}

static void ltdc_write(void *opaque, hwaddr addr, uint64_t value,
                       unsigned size)
{
    GnwLtdcState *s = opaque;
    int idx = addr / 4;

    switch (idx) {
    case L_ISR: case L_CPSR: case L_CDSR:
        return;
    case L_ICR:
        s->regs[L_ISR] &= ~value;
        ltdc_update_irq(s);
        return;
    case L_SRCR:
        if (value & 1) {
            /*
             * Immediate reload.  RRIF is only raised by a vertical-blanking
             * reload (RM0455 LTDC_ISR.RRIF).  Raising it here left a stale
             * flag behind Retro-Go's HAL_LTDC_SetAddress() in the reload
             * callback; the next HAL_LTDC_Reload() enabled RRIE, the stale
             * flag fired at once, and the callback pointed the display at
             * the buffer about to be drawn (visible redraw flicker).
             */
            s->regs[L_SRCR] = 0;
            ltdc_reload(s);
        } else {
            s->regs[L_SRCR] = value & 2;
        }
        return;
    case L_GCR: {
        bool was = s->regs[L_GCR] & 1;
        s->regs[idx] = value;
        if (!was && (value & 1)) {
            ltdc_start(s);
        } else if (!(value & 1)) {
            timer_del(s->frame_timer);
        }
        return;
    }
    case L_IER:
        s->regs[idx] = value;
        ltdc_update_irq(s);
        return;
    case L_LIPCR:
    case L_BPCR:
    case L_AWCR:
    case L_TWCR:
        /* Timing changed: re-place the next event within the frame. */
        s->regs[idx] = value;
        if (s->regs[L_GCR] & 1) {
            ltdc_schedule(s);
        }
        return;
    }
    if (idx == LY(0, LY_CLUTWR) || idx == LY(1, LY_CLUTWR)) {
        int n = idx == LY(1, LY_CLUTWR);
        s->clut[n][value >> 24] = 0xff000000 | (value & 0xffffff);
        return;
    }
    s->regs[idx] = value;
}

static const MemoryRegionOps ltdc_ops = {
    .read = ltdc_read,
    .write = ltdc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

/* ------------------------------------------------------------------ */
/* DMA2D                                                                */

#define D_CR        (0x00 / 4)
#define D_ISR       (0x04 / 4)
#define D_IFCR      (0x08 / 4)
#define D_FGMAR     (0x0c / 4)
#define D_FGOR      (0x10 / 4)
#define D_BGMAR     (0x14 / 4)
#define D_BGOR      (0x18 / 4)
#define D_FGPFCCR   (0x1c / 4)
#define D_FGCOLR    (0x20 / 4)
#define D_BGPFCCR   (0x24 / 4)
#define D_BGCOLR    (0x28 / 4)
#define D_FGCMAR    (0x2c / 4)
#define D_BGCMAR    (0x30 / 4)
#define D_OPFCCR    (0x34 / 4)
#define D_OCOLR     (0x38 / 4)
#define D_OMAR      (0x3c / 4)
#define D_OOR       (0x40 / 4)
#define D_NLR       (0x44 / 4)

static void dma2d_update_irq(GnwLtdcState *s)
{
    uint32_t ie = extract32(s->d2d[D_CR], 8, 6);

    qemu_set_irq(s->dma2d_irq, (ie & s->d2d[D_ISR] & 0x3f) != 0);
}

static void dma2d_load_clut(GnwLtdcState *s, int bg)
{
    uint32_t pfccr = s->d2d[bg ? D_BGPFCCR : D_FGPFCCR];
    uint32_t addr = s->d2d[bg ? D_BGCMAR : D_FGCMAR];
    int n = extract32(pfccr, 8, 8) + 1;
    bool rgb888 = pfccr & (1 << 4);
    uint32_t *clut = bg ? s->d2d_bgclut : s->d2d_fgclut;
    uint8_t buf[256 * 4];

    dma_memory_read(&address_space_memory, addr, buf, n * (rgb888 ? 3 : 4),
                    MEMTXATTRS_UNSPECIFIED);
    for (int i = 0; i < n; i++) {
        clut[i] = pixel_get(buf, rgb888 ? PF_RGB888 : PF_ARGB8888, i, NULL, 0);
    }
    s->d2d[bg ? D_BGPFCCR : D_FGPFCCR] &= ~(1 << 5);
    s->d2d[D_ISR] |= 1 << 4;    /* CTCIF */
}

/* Apply the alpha mode/value of a PFCCR register to a pixel. */
static uint32_t dma2d_alpha(uint32_t pfccr, uint32_t c)
{
    uint32_t am = extract32(pfccr, 16, 2), alpha = pfccr >> 24;
    uint32_t a = c >> 24;

    if (am == 1) {
        a = alpha;
    } else if (am == 2) {
        a = a * alpha / 255;
    }
    return (a << 24) | (c & 0xffffff);
}

/*
 * FG in YCbCr mode (CM=1011): the buffer holds JPEG-codec output, i.e.
 * 8x8 blocks grouped per MCU (Y blocks, then Cb, then Cr).  CSS selects
 * the MCU geometry; FGOR pads the line to a whole number of MCUs.
 */
#define CM_YCBCR    11

static uint8_t clamp8(int v)
{
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

static void dma2d_ycbcr_line(GnwLtdcState *s, int y, int w, uint8_t *out)
{
    uint32_t pfccr = s->d2d[D_FGPFCCR];
    int css = extract32(pfccr, 18, 2);
    int mw = css ? 16 : 8, mh = css == 2 ? 16 : 8;
    int nyb = (mw / 8) * (mh / 8);
    int mcus = (w + extract32(s->d2d[D_FGOR], 0, 16)) / mw;
    int mcu_bytes = (nyb + 2) * 64;
    int ly = y % mh;
    uint32_t row = s->d2d[D_FGMAR] + (y / mh) * mcus * mcu_bytes;
    uint8_t *mcu = g_malloc(mcu_bytes);
    int cur = -1;

    for (int x = 0; x < w; x++) {
        int m = x / mw, lx = x % mw;
        int yb = (ly / 8) * (mw / 8) + lx / 8;
        int cx = css ? lx / 2 : lx, cy = css == 2 ? ly / 2 : ly;
        int Y, Cb, Cr;

        if (m != cur) {
            dma_memory_read(&address_space_memory, row + m * mcu_bytes, mcu,
                            mcu_bytes, MEMTXATTRS_UNSPECIFIED);
            cur = m;
        }
        Y = mcu[yb * 64 + (ly % 8) * 8 + lx % 8];
        Cb = mcu[nyb * 64 + cy * 8 + cx] - 128;
        Cr = mcu[(nyb + 1) * 64 + cy * 8 + cx] - 128;
        stl_le_p(out + x * 4, 0xff000000 |
                 (clamp8(Y + ((91881 * Cr) >> 16)) << 16) |
                 (clamp8(Y - ((22554 * Cb + 46802 * Cr) >> 16)) << 8) |
                 clamp8(Y + ((116130 * Cb) >> 16)));
    }
    g_free(mcu);
}

static void dma2d_run(GnwLtdcState *s)
{
    int mode = extract32(s->d2d[D_CR], 16, 3);
    int w = extract32(s->d2d[D_NLR], 16, 14);
    int h = extract32(s->d2d[D_NLR], 0, 16);
    int ofmt = s->d2d[D_OPFCCR] & 7;
    int ffmt = s->d2d[D_FGPFCCR] & 0xf, bfmt = s->d2d[D_BGPFCCR] & 0xf;
    int obpp = pf_bits[ofmt];
    bool ycbcr = ffmt == CM_YCBCR;
    uint8_t *fl = g_malloc(w * 4 + 4), *bl = g_malloc(w * 4 + 4),
            *ol = g_malloc(w * 4 + 4);

    for (int y = 0; y < h; y++) {
        uint32_t oaddr = s->d2d[D_OMAR] +
                         y * (w + extract32(s->d2d[D_OOR], 0, 16)) * obpp / 8;
        uint32_t faddr = ycbcr ? 0 : s->d2d[D_FGMAR] +
                         y * (w + extract32(s->d2d[D_FGOR], 0, 16)) *
                         pf_bits[ffmt] / 8;
        uint32_t baddr = s->d2d[D_BGMAR] +
                         y * (w + extract32(s->d2d[D_BGOR], 0, 16)) *
                         pf_bits[bfmt] / 8;

        if (ycbcr && mode != 3 && mode != 4) {
            dma2d_ycbcr_line(s, y, w, fl);
        } else if (mode != 3 && mode != 4) {
            dma_memory_read(&address_space_memory, faddr, fl,
                            (w * pf_bits[ffmt] + 7) / 8,
                            MEMTXATTRS_UNSPECIFIED);
        }
        if (mode == 2 || mode == 4) {
            dma_memory_read(&address_space_memory, baddr, bl,
                            (w * pf_bits[bfmt] + 7) / 8,
                            MEMTXATTRS_UNSPECIFIED);
        }
        if (mode == 0) {        /* plain copy, no conversion */
            memcpy(ol, fl, (w * pf_bits[ffmt] + 7) / 8);
            dma_memory_write(&address_space_memory, oaddr, ol,
                             (w * pf_bits[ffmt] + 7) / 8,
                             MEMTXATTRS_UNSPECIFIED);
            continue;
        }
        for (int x = 0; x < w; x++) {
            uint32_t c;
            if (mode == 3) {    /* register to memory: OCOLR is in ofmt */
                uint8_t tmp[4];
                stl_le_p(tmp, s->d2d[D_OCOLR]);
                c = pixel_get(tmp, ofmt, 0, NULL, 0);
            } else {
                uint32_t f = dma2d_alpha(s->d2d[D_FGPFCCR],
                                         mode == 4 ? s->d2d[D_FGCOLR] :
                                         ycbcr ? ldl_le_p(fl + x * 4) :
                                         pixel_get(fl, ffmt, x, s->d2d_fgclut,
                                                   s->d2d[D_FGCOLR]));
                c = f;
                if (mode == 2 || mode == 4 || mode == 5) {
                    uint32_t b = dma2d_alpha(s->d2d[D_BGPFCCR],
                                             mode == 5 ? s->d2d[D_BGCOLR] :
                                             pixel_get(bl, bfmt, x,
                                                       s->d2d_bgclut,
                                                       s->d2d[D_BGCOLR]));
                    uint32_t fa = f >> 24, ba = b >> 24;
                    uint32_t ra = fa + ba - fa * ba / 255;
                    c = (blend(f, b, fa) & 0xffffff) | (ra << 24);
                }
            }
            pixel_put(ol, ofmt, x, c);
        }
        dma_memory_write(&address_space_memory, oaddr, ol, w * obpp / 8,
                         MEMTXATTRS_UNSPECIFIED);
    }
    g_free(fl);
    g_free(bl);
    g_free(ol);
    s->d2d[D_CR] &= ~1;
    s->d2d[D_ISR] |= 1 << 1;    /* TCIF */
}

static uint64_t dma2d_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwLtdcState *s = opaque;

    return s->d2d[addr / 4];
}

static void dma2d_write(void *opaque, hwaddr addr, uint64_t value,
                        unsigned size)
{
    GnwLtdcState *s = opaque;
    int idx = addr / 4;

    if (addr >= 0x400) {
        return;
    }
    switch (idx) {
    case D_ISR:
        return;
    case D_IFCR:
        s->d2d[D_ISR] &= ~value;
        break;
    case D_FGPFCCR:
    case D_BGPFCCR:
        s->d2d[idx] = value;
        if (value & (1 << 5)) {
            dma2d_load_clut(s, idx == D_BGPFCCR);
        }
        break;
    case D_CR:
        s->d2d[idx] = value & ~6;   /* SUSP/ABORT not modelled */
        if (value & 1) {
            dma2d_run(s);
        }
        break;
    default:
        s->d2d[idx] = value;
        return;
    }
    dma2d_update_irq(s);
}

static const MemoryRegionOps dma2d_ops = {
    .read = dma2d_read,
    .write = dma2d_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gnw_ltdc_reset(DeviceState *dev)
{
    GnwLtdcState *s = GNW_LTDC(dev);

    timer_del(s->frame_timer);
    memset(s->regs, 0, sizeof(s->regs));
    memset(s->active, 0, sizeof(s->active));
    memset(s->d2d, 0, sizeof(s->d2d));
    for (int n = 0; n < 2; n++) {
        s->regs[LY(n, LY_CACR)] = 0xff;
        s->regs[LY(n, LY_BFCR)] = 0x607;
    }
    ltdc_reload(s);
    s->frame_ns = NANOSECONDS_PER_SECOND / 60;
}

static void gnw_ltdc_realize(DeviceState *dev, Error **errp)
{
    GnwLtdcState *s = GNW_LTDC(dev);

    s->con = qemu_graphic_console_create(dev, 0, &ltdc_gfx_ops, s);
    s->width = 320;
    s->height = 240;
    qemu_console_resize(s->con, s->width, s->height);
}

static void gnw_ltdc_init(Object *obj)
{
    GnwLtdcState *s = GNW_LTDC(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->ltdc_mmio, obj, &ltdc_ops, s, "ltdc", 0x200);
    memory_region_init_io(&s->dma2d_mmio, obj, &dma2d_ops, s, "dma2d",
                          0x1000);
    sysbus_init_mmio(sbd, &s->ltdc_mmio);
    sysbus_init_mmio(sbd, &s->dma2d_mmio);
    sysbus_init_irq(sbd, &s->ltdc_irq);
    sysbus_init_irq(sbd, &s->dma2d_irq);
    qdev_init_gpio_in_named(DEVICE(obj), ltdc_rail_in, "panel-power", 2);
    s->frame_timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, ltdc_frame_tick, s);
}

static int ltdc_state_loaded(void *opaque, int version)
{
    GnwLtdcState *s = opaque;
    return s->width > 0 && s->width <= 4096 && s->height > 0 &&
                   s->height <= 4096 && s->phase >= 0 && s->phase <= 1
               ? 0
               : -EINVAL;
}
void gnw_ltdc_restore(GnwLtdcState *s)
{
    /* The console surface belongs to the host and was not migrated. */
    qemu_console_resize(s->con, s->width, s->height);
    ltdc_update_display(s);
}
static const VMStateDescription vmstate_gnw_ltdc = {
    .name = "gnw_ltdc",
    .version_id = 1,
    .minimum_version_id = 1,
    .post_load = ltdc_state_loaded,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32_ARRAY(regs, GnwLtdcState, 128),
        VMSTATE_UINT32_ARRAY(active, GnwLtdcState, 128),
        VMSTATE_UINT32_2DARRAY(clut, GnwLtdcState, 2, 256),
        VMSTATE_UINT32_ARRAY(d2d, GnwLtdcState, 256),
        VMSTATE_UINT32_ARRAY(d2d_fgclut, GnwLtdcState, 256),
        VMSTATE_UINT32_ARRAY(d2d_bgclut, GnwLtdcState, 256),
        VMSTATE_INT32(width, GnwLtdcState),
        VMSTATE_INT32(height, GnwLtdcState),
        VMSTATE_INT32(phase, GnwLtdcState),
        VMSTATE_INT64(frame_start_ns, GnwLtdcState),
        VMSTATE_INT64(frame_ns, GnwLtdcState),
        VMSTATE_UINT64(frame_count, GnwLtdcState),
        VMSTATE_BOOL(rail_3v3, GnwLtdcState),
        VMSTATE_BOOL(rail_1v8_n, GnwLtdcState),
        VMSTATE_TIMER_PTR(frame_timer, GnwLtdcState),
        VMSTATE_END_OF_LIST()
    },
};

static void gnw_ltdc_class_init(ObjectClass *klass, const void *data)
{
    DEVICE_CLASS(klass)->vmsd = &vmstate_gnw_ltdc;
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->realize = gnw_ltdc_realize;
    device_class_set_legacy_reset(dc, gnw_ltdc_reset);
}

static const TypeInfo gnw_ltdc_info = {
    .name = TYPE_GNW_LTDC,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwLtdcState),
    .instance_init = gnw_ltdc_init,
    .class_init = gnw_ltdc_class_init,
};

static void gnw_ltdc_register_types(void)
{
    type_register_static(&gnw_ltdc_info);
}

type_init(gnw_ltdc_register_types)
