/*
 * Game & Watch: CRYP coprocessor, AES modes only (RM0455 section 37).
 *
 * The Zelda firmware protects its save slots with AES-GCM on this unit.
 * Supported: AES-ECB, AES-CBC, AES-CTR, AES key preparation and AES-GCM
 * (init, header, payload and final phases). Blocks are processed as soon
 * as four words sit in the input FIFO, so the unit is never busy.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/bitops.h"
#include "qemu/host-utils.h"
#include "hw/core/irq.h"
#include "crypto/aes.h"
#include "gnw.h"

#define R_CR        (0x00 / 4)
#define R_SR        (0x04 / 4)
#define R_DIN       (0x08 / 4)
#define R_DOUT      (0x0c / 4)
#define R_IMSCR     (0x14 / 4)
#define R_RISR      (0x18 / 4)
#define R_MISR      (0x1c / 4)
#define R_K0LR      (0x20 / 4)
#define R_IV0LR     (0x40 / 4)

#define CR_ALGODIR  (1 << 2)
#define CR_CRYPEN   (1 << 15)
#define CR_FFLUSH   (1 << 14)

#define FIFO_MAX    64

#define TYPE_GNW_CRYP "gnw-cryp"
OBJECT_DECLARE_SIMPLE_TYPE(GnwCrypState, GNW_CRYP)

struct GnwCrypState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    qemu_irq irq;
    uint32_t regs[0x100 / 4];
    uint32_t in[FIFO_MAX], out[FIFO_MAX];
    int nin, nout, outpos;

    /* GCM */
    uint8_t h[16], x[16], j0[16];
    uint64_t hdr_bytes, pay_bytes;
};

static int cr_algomode(uint32_t cr)
{
    return extract32(cr, 3, 3) | (extract32(cr, 19, 1) << 3);
}

static int cr_phase(uint32_t cr)
{
    return extract32(cr, 16, 2);
}

static uint32_t swap_word(uint32_t cr, uint32_t w)
{
    switch (extract32(cr, 6, 2)) {
    case 1: return ror32(w, 16);
    case 2: return bswap32(w);
    case 3: return revbit32(w);
    }
    return w;
}

static void get_key(GnwCrypState *s, AES_KEY *key, bool decrypt)
{
    int ks = extract32(s->regs[R_CR], 8, 2);    /* 0:128 1:192 2:256 */
    int words = 4 + ks * 2;
    uint8_t k[32];

    for (int i = 0; i < words; i++) {
        stl_be_p(k + i * 4, s->regs[R_K0LR + 8 - words + i]);
    }
    if (decrypt) {
        AES_set_decrypt_key(k, words * 32, key);
    } else {
        AES_set_encrypt_key(k, words * 32, key);
    }
}

static void get_iv(GnwCrypState *s, uint8_t iv[16])
{
    for (int i = 0; i < 4; i++) {
        stl_be_p(iv + i * 4, s->regs[R_IV0LR + i]);
    }
}

static void set_iv(GnwCrypState *s, const uint8_t iv[16])
{
    for (int i = 0; i < 4; i++) {
        s->regs[R_IV0LR + i] = ldl_be_p(iv + i * 4);
    }
}

static void inc32(uint8_t cb[16])
{
    stl_be_p(cb + 12, ldl_be_p(cb + 12) + 1);
}

/* GF(2^128) multiply for GHASH (NIST SP 800-38D, algorithm 1). */
static void gf_mul(uint8_t x[16], const uint8_t y[16])
{
    uint8_t z[16] = { 0 }, v[16];

    memcpy(v, y, 16);
    for (int i = 0; i < 128; i++) {
        if (x[i / 8] & (0x80 >> (i % 8))) {
            for (int j = 0; j < 16; j++) {
                z[j] ^= v[j];
            }
        }
        bool lsb = v[15] & 1;
        for (int j = 15; j > 0; j--) {
            v[j] = (v[j] >> 1) | (v[j - 1] << 7);
        }
        v[0] >>= 1;
        if (lsb) {
            v[0] ^= 0xe1;
        }
    }
    memcpy(x, z, 16);
}

static void ghash(GnwCrypState *s, const uint8_t b[16])
{
    for (int i = 0; i < 16; i++) {
        s->x[i] ^= b[i];
    }
    gf_mul(s->x, s->h);
}

static void push_out(GnwCrypState *s, const uint8_t b[16])
{
    uint32_t cr = s->regs[R_CR];

    for (int i = 0; i < 4 && s->nout < FIFO_MAX; i++) {
        s->out[s->nout++] = swap_word(cr, ldl_be_p(b + i * 4));
    }
}

static void gcm_init(GnwCrypState *s)
{
    AES_KEY key;
    uint8_t zero[16] = { 0 };

    get_key(s, &key, false);
    AES_encrypt(zero, s->h, &key);
    memset(s->x, 0, sizeof(s->x));
    get_iv(s, s->j0);
    /* The IV holds the first payload counter (J0 + 1). */
    stl_be_p(s->j0 + 12, ldl_be_p(s->j0 + 12) - 1);
    s->hdr_bytes = s->pay_bytes = 0;
}

/* Pick the interpretation of the GCM length block that matches the data. */
static uint64_t gcm_len(uint64_t raw, uint64_t seen, uint32_t cr)
{
    uint64_t alt = (uint64_t)swap_word(cr, (uint32_t)raw);

    if (DIV_ROUND_UP(raw, 128) * 16 == seen) {
        return raw;
    }
    if (DIV_ROUND_UP(alt, 128) * 16 == seen) {
        return alt;
    }
    return seen * 8;
}

static void process_block(GnwCrypState *s)
{
    uint32_t cr = s->regs[R_CR];
    bool dec = cr & CR_ALGODIR;
    int mode = cr_algomode(cr);
    uint8_t in[16], out[16], iv[16], ks[16];
    AES_KEY key;

    for (int i = 0; i < 4; i++) {
        stl_be_p(in + i * 4, swap_word(cr, s->in[i]));
    }
    s->nin -= 4;
    memmove(s->in, s->in + 4, s->nin * sizeof(uint32_t));

    switch (mode) {
    case 4: /* AES-ECB */
        get_key(s, &key, dec);
        if (dec) {
            AES_decrypt(in, out, &key);
        } else {
            AES_encrypt(in, out, &key);
        }
        push_out(s, out);
        break;
    case 5: /* AES-CBC */
        get_iv(s, iv);
        get_key(s, &key, dec);
        if (dec) {
            AES_decrypt(in, out, &key);
            for (int i = 0; i < 16; i++) {
                out[i] ^= iv[i];
            }
            set_iv(s, in);
        } else {
            for (int i = 0; i < 16; i++) {
                in[i] ^= iv[i];
            }
            AES_encrypt(in, out, &key);
            set_iv(s, out);
        }
        push_out(s, out);
        break;
    case 6: /* AES-CTR */
        get_iv(s, iv);
        get_key(s, &key, false);
        AES_encrypt(iv, ks, &key);
        for (int i = 0; i < 16; i++) {
            out[i] = in[i] ^ ks[i];
        }
        inc32(iv);
        set_iv(s, iv);
        push_out(s, out);
        break;
    case 8: /* AES-GCM */
        switch (cr_phase(cr)) {
        case 1: /* header */
            ghash(s, in);
            s->hdr_bytes += 16;
            break;
        case 2: /* payload */
            get_iv(s, iv);
            get_key(s, &key, false);
            AES_encrypt(iv, ks, &key);
            for (int i = 0; i < 16; i++) {
                out[i] = in[i] ^ ks[i];
            }
            inc32(iv);
            set_iv(s, iv);
            ghash(s, dec ? in : out);
            s->pay_bytes += 16;
            push_out(s, out);
            break;
        case 3: { /* final: len(A) || len(C) in bits */
            uint64_t alen = gcm_len(ldl_be_p(in + 4), s->hdr_bytes, cr);
            uint64_t clen = gcm_len(ldl_be_p(in + 12), s->pay_bytes, cr);
            uint8_t lb[16];
            stq_be_p(lb, alen);
            stq_be_p(lb + 8, clen);
            ghash(s, lb);
            get_key(s, &key, false);
            AES_encrypt(s->j0, ks, &key);
            for (int i = 0; i < 16; i++) {
                out[i] = s->x[i] ^ ks[i];
            }
            push_out(s, out);
            break;
        }
        }
        break;
    default:
        qemu_log_mask(LOG_UNIMP, "gnw-cryp: algorithm %d not modelled\n",
                      mode);
        push_out(s, in);
        break;
    }
}

static void cryp_update(GnwCrypState *s)
{
    uint32_t risr = 0;

    while ((s->regs[R_CR] & CR_CRYPEN) && s->nin >= 4) {
        process_block(s);
    }
    if ((s->regs[R_CR] & CR_CRYPEN) && s->nin < 4) {
        risr |= 1;
    }
    if (s->nout > s->outpos) {
        risr |= 2;
    }
    s->regs[R_RISR] = risr;
    s->regs[R_MISR] = risr & s->regs[R_IMSCR];
    qemu_set_irq(s->irq, s->regs[R_MISR] != 0);
}

static uint64_t cryp_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwCrypState *s = opaque;
    uint32_t v;

    switch (addr / 4) {
    case R_SR: {
        int avail = s->nout - s->outpos;
        v = (s->nin == 0 ? 1 : 0) | (s->nin < 8 ? 2 : 0) |
            (avail ? 4 : 0) | (avail >= 8 ? 8 : 0);
        return v;
    }
    case R_DOUT:
        v = 0;
        if (s->outpos < s->nout) {
            v = s->out[s->outpos++];
            if (s->outpos == s->nout) {
                s->outpos = s->nout = 0;
            }
        }
        cryp_update(s);
        return v;
    case R_DIN:
        return 0;
    }
    return s->regs[addr / 4];
}

static void cryp_write(void *opaque, hwaddr addr, uint64_t value,
                       unsigned size)
{
    GnwCrypState *s = opaque;
    uint32_t old = s->regs[R_CR];

    switch (addr / 4) {
    case R_SR: case R_DOUT: case R_RISR: case R_MISR:
        return;
    case R_DIN:
        if (s->nin < FIFO_MAX) {
            s->in[s->nin++] = value;
        }
        break;
    case R_CR:
        if (value & CR_FFLUSH) {
            s->nin = s->nout = s->outpos = 0;
            value &= ~CR_FFLUSH;
        }
        s->regs[R_CR] = value;
        if (!(old & CR_CRYPEN) && (value & CR_CRYPEN)) {
            int mode = cr_algomode(value);
            if (mode == 7) {            /* key preparation: nothing to do */
                s->regs[R_CR] &= ~CR_CRYPEN;
            } else if (mode == 8 && cr_phase(value) == 0) {
                gcm_init(s);
                s->regs[R_CR] &= ~CR_CRYPEN;
            }
        }
        break;
    default:
        s->regs[addr / 4] = value;
        break;
    }
    cryp_update(s);
}

static const MemoryRegionOps cryp_ops = {
    .read = cryp_read,
    .write = cryp_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gnw_cryp_reset(DeviceState *dev)
{
    GnwCrypState *s = GNW_CRYP(dev);

    memset(s->regs, 0, sizeof(s->regs));
    s->nin = s->nout = s->outpos = 0;
    cryp_update(s);
}

static void gnw_cryp_init(Object *obj)
{
    GnwCrypState *s = GNW_CRYP(obj);

    memory_region_init_io(&s->mmio, obj, &cryp_ops, s, "cryp", 0x400);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->mmio);
    sysbus_init_irq(SYS_BUS_DEVICE(obj), &s->irq);
}

static void gnw_cryp_class_init(ObjectClass *klass, const void *data)
{
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_cryp_reset);
}

static const TypeInfo gnw_cryp_info = {
    .name = TYPE_GNW_CRYP,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwCrypState),
    .instance_init = gnw_cryp_init,
    .class_init = gnw_cryp_class_init,
};

static void gnw_cryp_register_types(void)
{
    type_register_static(&gnw_cryp_info);
}

type_init(gnw_cryp_register_types)
