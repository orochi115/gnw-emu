/*
 * Game & Watch: DMA1/DMA2 streams, DMAMUX1 and SAI1.
 *
 * Memory-to-memory streams complete immediately. A memory-to-peripheral
 * stream feeding SAI1 is paced at the SAI frame rate (derived from the
 * RCC PLL and SAI divider setup), raising half/full transfer interrupts
 * like the real audio path. The firmware's frame pacing may depend on
 * those interrupts. Samples can be written to a WAV file and, when an
 * audiodev is set, played on the host.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/timer.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "hw/core/qdev-properties.h"
#include "system/address-spaces.h"
#include "system/dma.h"
#include "gnw.h"
#include "qemu/audio.h"
#include "system/system.h"

#define PCM_RING (64 * 1024)

#define SAI1_BASE   0x40015800
#define S_CR        0
#define S_NDTR      1
#define S_PAR       2
#define S_M0AR      3
#define S_M1AR      4

#define CR_EN       (1 << 0)
#define CR_TEIE     (1 << 2)
#define CR_HTIE     (1 << 3)
#define CR_TCIE     (1 << 4)
#define CR_CIRC     (1 << 8)
#define CR_PINC     (1 << 9)
#define CR_MINC     (1 << 10)
#define CR_DBM      (1 << 18)
#define CR_CT       (1 << 19)

#define F_HT        (1 << 4)
#define F_TC        (1 << 5)

static const int flag_shift[4] = { 0, 6, 16, 22 };

static uint32_t *sreg(GnwDmaState *s, int c, int i)
{
    return &s->dma[c][(0x10 + i * 0x18) / 4];
}

static uint32_t *isr_reg(GnwDmaState *s, int c, int i)
{
    return &s->dma[c][i < 4 ? 0 : 1];
}

static void stream_update_irq(GnwDmaState *s, int c, int i)
{
    uint32_t cr = sreg(s, c, i)[S_CR];
    uint32_t fl = (*isr_reg(s, c, i) >> flag_shift[i % 4]) & 0x3d;
    uint32_t en = 0;

    if (cr & CR_TCIE) {
        en |= F_TC;
    }
    if (cr & CR_HTIE) {
        en |= F_HT;
    }
    if (cr & CR_TEIE) {
        en |= 1 << 3;
    }
    qemu_set_irq(s->irq[c][i], (fl & en) != 0);
}

static void stream_flag(GnwDmaState *s, int c, int i, uint32_t f)
{
    *isr_reg(s, c, i) |= f << flag_shift[i % 4];
    stream_update_irq(s, c, i);
}

/* ------------------------------------------------------------------ */
/* SAI1 frame rate                                                      */

static uint64_t pll_out(GnwRegs *rcc, int pll, int div)
{
    uint32_t *r = rcc->regs;
    uint32_t cksel = r[0x28 / 4];
    uint32_t src = extract32(cksel, 0, 2);
    uint32_t divm = extract32(cksel, 4 + pll * 8, 6);
    uint32_t divr = r[(0x30 + pll * 8) / 4];
    uint32_t frac = extract32(r[(0x34 + pll * 8) / 4], 3, 13);
    uint64_t in;
    uint64_t vco_x8192;

    switch (src) {
    case 0: in = 64000000 >> extract32(r[0], 3, 2); break;
    case 1: in = 4000000; break;
    default: in = 8000000; break;   /* HSE, not fitted on the board */
    }
    if (divm == 0) {
        return 0;
    }
    vco_x8192 = in * ((extract32(divr, 0, 9) + 1) * 8192ULL + frac) / divm;
    return vco_x8192 / 8192 / (extract32(divr, div, 7) + 1);
}

static uint32_t sai_frame_rate(GnwDmaState *s, int block)
{
    uint32_t *b = &s->sai[(0x04 + block * 0x20) / 4];
    uint32_t cr1 = b[0], frcr = b[2];
    uint32_t mckdiv = extract32(cr1, 20, 6);
    bool nodiv = cr1 & (1 << 19);
    bool osr = cr1 & (1 << 26);
    uint64_t ker = 0;
    uint32_t fs;

    if (s->rcc) {
        /* RCC_CDCCIP1R.SAI1SEL */
        switch (extract32(s->rcc->regs[0x50 / 4], 0, 3)) {
        case 0: ker = pll_out(s->rcc, 0, 16); break;   /* pll1_q */
        case 1: ker = pll_out(s->rcc, 1, 9); break;    /* pll2_p */
        case 2: ker = pll_out(s->rcc, 2, 9); break;    /* pll3_p */
        default: ker = 0; break;
        }
    }
    if (mckdiv == 0) {
        mckdiv = 1;
    }
    if (!ker) {
        fs = 0;
    } else if (nodiv) {
        fs = ker / ((extract32(frcr, 0, 8) + 1) * mckdiv);
    } else {
        fs = ker / (mckdiv * (osr ? 2 : 1) * 256);
    }
    if (s->sample_rate) {
        fs = s->sample_rate;
    } else if (fs < 4000 || fs > 192000) {
        qemu_log_mask(LOG_UNIMP, "gnw-sai: odd frame rate %u, using 48k\n",
                      fs);
        fs = 48000;
    }
    return fs;
}

static int sai_data_per_frame(GnwDmaState *s, int block)
{
    uint32_t *b = &s->sai[(0x04 + block * 0x20) / 4];
    uint32_t nb = extract32(b[3], 8, 4) + 1;
    uint32_t en = extract32(b[3], 16, 16) & ((1u << nb) - 1);

    if (b[0] & (1 << 12)) {     /* MONO */
        return 1;
    }
    return en ? ctpop32(en) : 2;
}

/* ------------------------------------------------------------------ */
/* WAV capture                                                          */

static void wav_header(GnwDmaState *s, uint32_t rate, int channels)
{
    uint8_t h[44];

    memcpy(h, "RIFF", 4);
    stl_le_p(h + 4, 36 + s->wav_bytes);
    memcpy(h + 8, "WAVEfmt ", 8);
    stl_le_p(h + 16, 16);
    stw_le_p(h + 20, 1);
    stw_le_p(h + 22, channels);
    stl_le_p(h + 24, rate);
    stl_le_p(h + 28, rate * channels * 2);
    stw_le_p(h + 32, channels * 2);
    stw_le_p(h + 34, 16);
    memcpy(h + 36, "data", 4);
    stl_le_p(h + 40, s->wav_bytes);
    fseek(s->wav, 0, SEEK_SET);
    fwrite(h, 1, sizeof(h), s->wav);
    fseek(s->wav, 0, SEEK_END);
}

static void wav_capture(GnwDmaState *s, uint32_t addr, uint32_t len,
                        int channels)
{
    uint8_t *buf;

    if (!s->wav_path) {
        return;
    }
    if (!s->wav) {
        s->wav = fopen(s->wav_path, "wb");
        if (!s->wav) {
            g_clear_pointer(&s->wav_path, g_free);
            return;
        }
        wav_header(s, sai_frame_rate(s, 0), channels);
    }
    buf = g_malloc(len);
    dma_memory_read(&address_space_memory, addr, buf, len,
                    MEMTXATTRS_UNSPECIFIED);
    fwrite(buf, 1, len, s->wav);
    g_free(buf);
    s->wav_bytes += len;
    wav_header(s, sai_frame_rate(s, 0), channels);
}

/* ------------------------------------------------------------------ */
/* Host playback uses QEMU's selected backend on every platform. */
void gnw_dma_set_muted(GnwDmaState *s, bool muted)
{
    s->muted = muted;
    s->pcm_r = s->pcm_fill = 0;
    if (s->voice) {
        audio_be_set_volume_out_lr(s->audio_be, s->voice, muted, 255, 255);
    }
}

/* Audio callbacks and guest DMA execute under QEMU's main-loop lock.
 * Only owned PCM enters this bounded queue; no guest RAM is retained. */
static void host_fill(void *opaque, int available)
{
    GnwDmaState *s = opaque;

    while (s->voice && s->pcm_fill && available >= 4) {
        unsigned chunk = MIN((unsigned)available, s->pcm_fill);
        size_t written;

        chunk = MIN(chunk, PCM_RING - s->pcm_r) & ~3u;
        written = audio_be_write(s->audio_be, s->voice,
                                 s->pcm + s->pcm_r, chunk);
        if (!written) {
            break;
        }
        s->pcm_r = (s->pcm_r + written) % PCM_RING;
        s->pcm_fill -= written;
        available -= written;
    }
}

static void host_open(GnwDmaState *s, uint32_t rate, int channels)
{
    struct audsettings settings = {
        .freq = rate, .nchannels = channels,
        .fmt = AUDIO_FORMAT_S16, .big_endian = false,
    };

    if (s->voice_rate == rate && s->voice_ch == channels) {
        return;
    }
    if (!rate || channels != 2) {
        return;
    }
    s->pcm_r = s->pcm_fill = 0;
    /* A failed backend is not retried on every guest half-buffer. */
    s->voice_rate = rate;
    s->voice_ch = channels;
    s->voice = audio_be_open_out(s->audio_be, s->voice, "gnw-sai",
                                 s, host_fill, &settings);
    if (!s->voice) {
        return;
    }
    s->voice_rate = rate;
    s->voice_ch = channels;
    audio_be_set_volume_out_lr(s->audio_be, s->voice, s->muted, 255, 255);
    audio_be_set_active_out(s->audio_be, s->voice, true);
}

static void host_push(GnwDmaState *s, const uint8_t *src,
                      uint32_t len, int channels)
{
    unsigned frame_bytes = channels * 2;
    unsigned high = MIN(PCM_RING, (unsigned)s->voice_rate * 4 / 10) & ~3u;

    if (!s->pcm) {
        s->pcm = g_malloc(PCM_RING);
    }
    /* Keep at most 100 ms, dropping old complete stereo frames if the
     * host is slower. Host consumption never changes virtual DMA timing. */
    for (unsigned i = 0; i + frame_bytes <= len; i += frame_bytes) {
        unsigned pos;
        if (s->pcm_fill + 4 > high) {
            s->pcm_r = (s->pcm_r + 4) % PCM_RING;
            s->pcm_fill -= 4;
        }
        pos = (s->pcm_r + s->pcm_fill) % PCM_RING;
        memcpy(s->pcm + pos, src + i, 2);
        memcpy(s->pcm + pos + 2, src + i + (channels == 1 ? 0 : 2), 2);
        s->pcm_fill += 4;
    }
}

static void host_play(GnwDmaState *s, uint32_t addr, uint32_t len,
                      uint32_t rate, int channels)
{
    uint8_t *buf;

    if (!s->playback || !len || channels < 1) {
        return;
    }
    host_open(s, rate, channels == 1 ? 2 : channels);
    if (!s->voice) {
        return;
    }
    buf = g_malloc(len);
    dma_memory_read(&address_space_memory, addr, buf, len,
                    MEMTXATTRS_UNSPECIFIED);
    host_push(s, buf, len, channels);
    g_free(buf);
}

/* ------------------------------------------------------------------ */
/* Streams                                                              */

static int stream_psize(uint32_t cr)
{
    return 1 << extract32(cr, 11, 2);
}

static int stream_msize(uint32_t cr)
{
    return 1 << extract32(cr, 13, 2);
}

static void stream_copy_now(GnwDmaState *s, int c, int i)
{
    uint32_t *r = sreg(s, c, i);
    uint32_t cr = r[S_CR];
    uint32_t n = r[S_NDTR] & 0xffff;
    int dir = extract32(cr, 6, 2);
    int ps = stream_psize(cr), ms = stream_msize(cr);
    uint32_t pa = r[S_PAR], ma = r[S_M0AR];

    if (dir == 2) {             /* memory to memory: PAR -> M0AR */
        uint8_t tmp[4];
        for (uint32_t k = 0; k < n; k++) {
            dma_memory_read(&address_space_memory,
                            pa + ((cr & CR_PINC) ? k * ps : 0), tmp, ps,
                            MEMTXATTRS_UNSPECIFIED);
            dma_memory_write(&address_space_memory,
                             ma + ((cr & CR_MINC) ? k * ms : 0), tmp, ps,
                             MEMTXATTRS_UNSPECIFIED);
        }
    }
    r[S_NDTR] = 0;
    r[S_CR] &= ~CR_EN;
    stream_flag(s, c, i, F_HT | F_TC);
}

static void stream_buffer(GnwDmaState *s, GnwDmaStream *st, int half)
{
    uint32_t *r = sreg(s, st->ctrl, st->idx);
    uint32_t cr = r[S_CR];
    uint32_t base = (cr & CR_CT) ? r[S_M1AR] : r[S_M0AR];
    uint32_t bytes = st->total * stream_msize(cr);
    int ch = sai_data_per_frame(s, 0);
    uint32_t off = half ? bytes / 2 : 0;

    {
        /*
         * Debug: a non-silent half captured unchanged one cycle later.
         * Usually the guest missed a DMA event and the old audio replays;
         * looping music can also repeat exactly, so compare with a
         * deterministic run before blaming the timing.
         */
        static uint8_t prev[2][8192];
        static uint64_t stale;
        uint8_t cur[8192];
        uint32_t n = MIN(bytes / 2, sizeof(cur));
        bool silent = true;

        dma_memory_read(&address_space_memory, base + off, cur, n,
                        MEMTXATTRS_UNSPECIFIED);
        for (uint32_t k = 0; k < n && silent; k++) {
            silent = !cur[k];
        }
        if (!silent && !memcmp(cur, prev[half], n)) {
            stale++;
            qemu_log_mask(LOG_UNIMP, "gnw-dma: half %d unchanged since last "
                          "cycle (%" PRIu64 " so far) at %.3f s\n", half,
                          stale, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) / 1e9);
        }
        memcpy(prev[half], cur, n);
    }
    wav_capture(s, base + off, bytes / 2, ch);
    host_play(s, base + off, bytes / 2, sai_frame_rate(s, 0), ch);
}

static void stream_tick(void *opaque)
{
    GnwDmaStream *st = opaque;
    GnwDmaState *s = st->dma;
    uint32_t *r = sreg(s, st->ctrl, st->idx);

    if (!(r[S_CR] & CR_EN)) {
        return;
    }
    {
        /* Debug (-d unimp): how late do the half/full transfer events fire? */
        static int64_t worst, n_late, last_rep;
        int64_t sched = st->start_ns + st->item_ns * st->total /
                        (st->half_done ? 1 : 2);
        int64_t now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
        int64_t late = now - sched;

        worst = MAX(worst, late);
        n_late += late > 4 * SCALE_MS;
        if (now - last_rep > 2 * NANOSECONDS_PER_SECOND) {
            qemu_log_mask(LOG_UNIMP, "gnw-dma: event lateness max %.2f ms, "
                          "%" PRId64 " > 4 ms\n", worst / 1e6, n_late);
            worst = n_late = 0;
            last_rep = now;
        }
    }
    if (!st->half_done) {
        st->half_done = true;
        stream_buffer(s, st, 0);
        stream_flag(s, st->ctrl, st->idx, F_HT);
        timer_mod(st->timer, st->start_ns + st->item_ns * st->total);
        return;
    }
    stream_buffer(s, st, 1);
    st->half_done = false;
    st->start_ns += st->item_ns * st->total;
    if (r[S_CR] & CR_DBM) {
        r[S_CR] ^= CR_CT;
    } else if (!(r[S_CR] & CR_CIRC)) {
        r[S_CR] &= ~CR_EN;
        r[S_NDTR] = 0;
        stream_flag(s, st->ctrl, st->idx, F_TC);
        return;
    }
    stream_flag(s, st->ctrl, st->idx, F_TC);
    timer_mod(st->timer, st->start_ns + st->item_ns * st->total / 2);
}

/* ------------------------------------------------------------------ */
/* Peripheral handshake (SPI1)                                          */

#define SPI1_BASE   0x40013000

static GnwDmaStream *req_stream(GnwDmaState *s, int req)
{
    for (int ch = 0; ch < 16; ch++) {
        int c = ch / 8, i = ch % 8;

        if ((s->dmamux[ch] & 0x7f) == req &&
            (sreg(s, c, i)[S_CR] & CR_EN) && s->stream[c][i].periph) {
            return &s->stream[c][i];
        }
    }
    return NULL;
}

bool gnw_dma_req_active(GnwDmaState *s, int req)
{
    return req_stream(s, req) != NULL;
}

/* One item done: advance NDTR, raise HT/TC, stop unless circular. */
static void periph_item_done(GnwDmaState *s, GnwDmaStream *st)
{
    uint32_t *r = sreg(s, st->ctrl, st->idx);
    uint32_t n = (r[S_NDTR] & 0xffff) - 1;

    r[S_NDTR] = n;
    if (n == st->total / 2) {
        stream_flag(s, st->ctrl, st->idx, F_HT);
    }
    if (n == 0) {
        if (r[S_CR] & CR_CIRC) {
            r[S_NDTR] = st->total;
        } else {
            r[S_CR] &= ~CR_EN;
        }
        stream_flag(s, st->ctrl, st->idx, F_TC);
    }
}

static uint32_t periph_mem_addr(GnwDmaState *s, GnwDmaStream *st, int *ms)
{
    uint32_t *r = sreg(s, st->ctrl, st->idx);
    uint32_t cr = r[S_CR];
    uint32_t done = st->total - (r[S_NDTR] & 0xffff);

    *ms = stream_msize(cr);
    return r[S_M0AR] + ((cr & CR_MINC) ? done * *ms : 0);
}

bool gnw_dma_req_mem_to_periph(GnwDmaState *s, int req, uint32_t *item)
{
    GnwDmaStream *st = req_stream(s, req);
    uint32_t v = 0;
    int ms;
    uint32_t a;

    if (!st || extract32(sreg(s, st->ctrl, st->idx)[S_CR], 6, 2) != 1) {
        return false;
    }
    a = periph_mem_addr(s, st, &ms);
    dma_memory_read(&address_space_memory, a, &v, ms, MEMTXATTRS_UNSPECIFIED);
    *item = le32_to_cpu(v);
    periph_item_done(s, st);
    return true;
}

bool gnw_dma_req_periph_to_mem(GnwDmaState *s, int req, uint32_t item)
{
    GnwDmaStream *st = req_stream(s, req);
    uint32_t v = cpu_to_le32(item);
    int ms;
    uint32_t a;

    if (!st || extract32(sreg(s, st->ctrl, st->idx)[S_CR], 6, 2) != 0) {
        return false;
    }
    a = periph_mem_addr(s, st, &ms);
    dma_memory_write(&address_space_memory, a, &v, ms,
                     MEMTXATTRS_UNSPECIFIED);
    periph_item_done(s, st);
    return true;
}

static void stream_enable(GnwDmaState *s, int c, int i)
{
    uint32_t *r = sreg(s, c, i);
    uint32_t pa = r[S_PAR];
    GnwDmaStream *st = &s->stream[c][i];
    int dir = extract32(r[S_CR], 6, 2);

    st->periph = false;
    if (dir != 2 && pa >= SPI1_BASE && pa < SPI1_BASE + 0x400) {
        st->periph = true;
        st->total = r[S_NDTR] & 0xffff;
        if (s->periph_kick) {
            s->periph_kick(s->periph_opaque);
        }
        return;
    }

    if (dir == 1 && pa >= SAI1_BASE && pa < SAI1_BASE + 0x400) {
        int block = pa >= SAI1_BASE + 0x40 ? 1 : 0;
        uint32_t fs = sai_frame_rate(s, block);
        int dpf = sai_data_per_frame(s, block);

        st->total = MAX(r[S_NDTR] & 0xffff, 2);
        st->item_ns = NANOSECONDS_PER_SECOND / ((int64_t)fs * dpf);
        st->start_ns = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
        st->half_done = false;
        qemu_log_mask(LOG_UNIMP, "gnw-dma: DMA%d S%d -> SAI1%c, %u Hz x%d, "
                      "%u items%s\n", c + 1, i, 'A' + block, fs, dpf,
                      st->total, (r[S_CR] & CR_CIRC) ? " circular" : "");
        timer_mod(st->timer, st->start_ns + st->item_ns * st->total / 2);
        return;
    }
    qemu_log_mask(LOG_UNIMP, "gnw-dma: DMA%d S%d dir %d PAR 0x%08x M0AR "
                  "0x%08x n %u: completing at once\n", c + 1, i, dir, pa,
                  r[S_M0AR], r[S_NDTR]);
    stream_copy_now(s, c, i);
}

static uint64_t dma_read(GnwDmaState *s, int c, hwaddr addr)
{
    int idx = addr / 4;

    if (addr >= 0x10 && addr < 0xd0) {
        int i = (addr - 0x10) / 0x18, f = ((addr - 0x10) % 0x18) / 4;
        GnwDmaStream *st = &s->stream[c][i];
        uint32_t *r = sreg(s, c, i);

        if (f == S_NDTR && (r[S_CR] & CR_EN) && st->item_ns) {
            int64_t now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
            int64_t done = (now - st->start_ns) / st->item_ns;
            return st->total - MIN(MAX(done, 0), st->total - 1);
        }
    }
    return s->dma[c][idx];
}

static void dma_write(GnwDmaState *s, int c, hwaddr addr, uint32_t value)
{
    int idx = addr / 4;

    if (idx == 0 || idx == 1) {
        return;
    }
    if (idx == 2 || idx == 3) {         /* LIFCR / HIFCR */
        s->dma[c][idx - 2] &= ~value;
        for (int i = (idx - 2) * 4; i < (idx - 2) * 4 + 4; i++) {
            stream_update_irq(s, c, i);
        }
        return;
    }
    if (addr >= 0x10 && addr < 0xd0) {
        int i = (addr - 0x10) / 0x18, f = ((addr - 0x10) % 0x18) / 4;
        uint32_t old = s->dma[c][idx];

        s->dma[c][idx] = value;
        if (f == S_CR) {
            if (!(old & CR_EN) && (value & CR_EN)) {
                stream_enable(s, c, i);
            } else if ((old & CR_EN) && !(value & CR_EN)) {
                timer_del(s->stream[c][i].timer);
                s->stream[c][i].item_ns = 0;
            }
            stream_update_irq(s, c, i);
        }
        return;
    }
    s->dma[c][idx] = value;
}

static uint64_t dma1_read(void *opaque, hwaddr addr, unsigned size)
{
    return dma_read(opaque, 0, addr);
}

static void dma1_write(void *opaque, hwaddr addr, uint64_t v, unsigned size)
{
    dma_write(opaque, 0, addr, v);
}

static uint64_t dma2_read(void *opaque, hwaddr addr, unsigned size)
{
    return dma_read(opaque, 1, addr);
}

static void dma2_write(void *opaque, hwaddr addr, uint64_t v, unsigned size)
{
    dma_write(opaque, 1, addr, v);
}

static const MemoryRegionOps dma_ops[2] = {
    {
        .read = dma1_read,
        .write = dma1_write,
        .endianness = DEVICE_LITTLE_ENDIAN,
        .valid.min_access_size = 4,
        .valid.max_access_size = 4,
    }, {
        .read = dma2_read,
        .write = dma2_write,
        .endianness = DEVICE_LITTLE_ENDIAN,
        .valid.min_access_size = 4,
        .valid.max_access_size = 4,
    },
};

static uint64_t dmamux_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwDmaState *s = opaque;

    return s->dmamux[addr / 4];
}

static void dmamux_write(void *opaque, hwaddr addr, uint64_t v, unsigned size)
{
    GnwDmaState *s = opaque;

    s->dmamux[addr / 4] = v;
}

static const MemoryRegionOps dmamux_ops = {
    .read = dmamux_read,
    .write = dmamux_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static uint64_t sai_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwDmaState *s = opaque;
    hwaddr off = addr & ~3;
    uint32_t v = s->sai[off / 4];

    if (off == 0x18 || off == 0x38) {   /* xSR: FIFO empty, request */
        v = (1 << 3);
    }
    return v >> ((addr & 3) * 8);
}

static void sai_write(void *opaque, hwaddr addr, uint64_t v, unsigned size)
{
    GnwDmaState *s = opaque;
    hwaddr off = addr & ~3;

    if (off == 0x20 || off == 0x40) {   /* data registers */
        return;
    }
    if (off == 0x1c || off == 0x3c) {   /* CLRFR */
        return;
    }
    if (size != 4) {
        unsigned shift = (addr & 3) * 8;
        uint32_t mask = ((1u << (size * 8)) - 1) << shift;
        v = (s->sai[off / 4] & ~mask) | ((v << shift) & mask);
    }
    s->sai[off / 4] = v;
}

static const MemoryRegionOps sai_ops = {
    .read = sai_read,
    .write = sai_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
};

static void gnw_dma_reset(DeviceState *dev)
{
    GnwDmaState *s = GNW_DMA(dev);

    for (int c = 0; c < 2; c++) {
        for (int i = 0; i < 8; i++) {
            timer_del(s->stream[c][i].timer);
            s->stream[c][i].item_ns = 0;
        }
    }
    memset(s->dma, 0, sizeof(s->dma));
    memset(s->dmamux, 0, sizeof(s->dmamux));
    memset(s->sai, 0, sizeof(s->sai));
    s->pcm_r = 0;
    s->pcm_fill = 0;
    s->sai[0x04 / 4] = 0x00000040;
    s->sai[0x0c / 4] = 0x00000007;
    s->sai[0x24 / 4] = 0x00000040;
    s->sai[0x2c / 4] = 0x00000007;
}

static void gnw_dma_init(Object *obj)
{
    GnwDmaState *s = GNW_DMA(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    for (int c = 0; c < 2; c++) {
        memory_region_init_io(&s->dma_mmio[c], obj, &dma_ops[c], s,
                              c ? "dma2" : "dma1", 0x400);
        sysbus_init_mmio(sbd, &s->dma_mmio[c]);
    }
    memory_region_init_io(&s->dmamux_mmio, obj, &dmamux_ops, s, "dmamux1",
                          0x400);
    memory_region_init_io(&s->sai_mmio, obj, &sai_ops, s, "sai1", 0x400);
    sysbus_init_mmio(sbd, &s->dmamux_mmio);
    sysbus_init_mmio(sbd, &s->sai_mmio);
    for (int c = 0; c < 2; c++) {
        for (int i = 0; i < 8; i++) {
            GnwDmaStream *st = &s->stream[c][i];
            st->dma = s;
            st->ctrl = c;
            st->idx = i;
            st->timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, stream_tick, st);
            sysbus_init_irq(sbd, &s->irq[c][i]);
        }
    }

}

static const Property gnw_dma_props[] = {
    DEFINE_PROP_UINT32("sample-rate", GnwDmaState, sample_rate, 0),
    DEFINE_PROP_STRING("wav", GnwDmaState, wav_path),
    DEFINE_PROP_BOOL("playback", GnwDmaState, playback, false),
    DEFINE_AUDIO_PROPERTIES(GnwDmaState, audio_be),
    DEFINE_PROP_BOOL("muted", GnwDmaState, muted, false),
};

static void gnw_dma_audio_exit(Notifier *notifier, void *data)
{
    GnwDmaState *s = container_of(notifier, GnwDmaState, audio_exit);
    if (s->voice) {
        audio_be_close_out(s->audio_be, s->voice);
        s->voice = NULL;
    }
    object_unref(OBJECT(s->audio_be));
    s->audio_be = NULL;
    s->audio_registered = false;
}

static void gnw_dma_realize(DeviceState *dev, Error **errp)
{
    GnwDmaState *s = GNW_DMA(dev);
    if (s->playback) {
        if (!audio_be_check(&s->audio_be, errp)) {
            return;
        }
        /* Retain the backend through audio_cleanup(), then close the voice
         * so capture backends finalize headers before the process exits. */
        object_ref(OBJECT(s->audio_be));
        s->audio_exit.notify = gnw_dma_audio_exit;
        s->audio_registered = true;
        qemu_add_exit_notifier(&s->audio_exit);
    }
}

static void gnw_dma_finalize(Object *obj)
{
    GnwDmaState *s = GNW_DMA(obj);
    if (s->audio_registered) {
        qemu_remove_exit_notifier(&s->audio_exit);
        gnw_dma_audio_exit(&s->audio_exit, NULL);
    }
    g_free(s->pcm);
    if (s->wav) {
        fclose(s->wav);
    }
}

static void gnw_dma_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->realize = gnw_dma_realize;
    device_class_set_legacy_reset(dc, gnw_dma_reset);
    device_class_set_props(dc, gnw_dma_props);
}

static const TypeInfo gnw_dma_info = {
    .name = TYPE_GNW_DMA,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwDmaState),
    .instance_init = gnw_dma_init,
    .instance_finalize = gnw_dma_finalize,
    .class_init = gnw_dma_class_init,
};

static void gnw_dma_register_types(void)
{
    type_register_static(&gnw_dma_info);
}

type_init(gnw_dma_register_types)
