/*
 * Game & Watch: STM32H7 SPI (v2, RM0455 section 52) in master mode.
 *
 * Used for SPI1, where the Retro-Go SD mod wires a microSD card
 * (PB3 SCK, PB4 MISO, PD7 MOSI, PB9 CS, PA15 power).  Frames are
 * exchanged with the attached device the moment they are written to TXDR
 * (or pulled from the TX DMA stream), so a transfer never waits for the
 * bus; the received frames queue in a 16-byte RX FIFO, or go straight to
 * the RX DMA stream.  CR2.TSIZE counts frames down to EOT, which raises
 * the SPI interrupt when enabled (HAL's DMA path finishes on EOT).
 *
 * Only 8-bit frames (DSIZE=7) are exchanged byte-wise; wider frames are
 * sent least significant byte first per frame, which nothing here uses.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qapi/error.h"
#include "hw/core/irq.h"
#include "hw/core/qdev-properties.h"
#include "gnw.h"

#define R_CR1       (0x00 / 4)
#define R_CR2       (0x04 / 4)
#define R_CFG1      (0x08 / 4)
#define R_CFG2      (0x0c / 4)
#define R_IER       (0x10 / 4)
#define R_SR        (0x14 / 4)
#define R_IFCR      (0x18 / 4)
#define R_CRCPOLY   (0x40 / 4)
#define R_I2SCFGR   (0x50 / 4)

#define CR1_SPE     (1 << 0)
#define CR1_CSTART  (1 << 9)
#define CR1_CSUSP   (1 << 10)

#define CFG1_RXDMAEN (1 << 14)
#define CFG1_TXDMAEN (1 << 15)

#define SR_RXP      (1 << 0)
#define SR_TXP      (1 << 1)
#define SR_DXP      (1 << 2)
#define SR_EOT      (1 << 3)
#define SR_TXTF     (1 << 4)
#define SR_OVR      (1 << 6)
#define SR_SUSP     (1 << 11)
#define SR_TXC      (1 << 12)
#define SR_RXWNE    (1 << 15)
#define SR_STICKY   0x0ff8      /* EOT..SUSP, cleared through IFCR */

static unsigned spi_dsize_bytes(GnwSpiState *s)
{
    return extract32(s->regs[R_CFG1], 0, 5) / 8 + 1;
}

static unsigned spi_fthlv(GnwSpiState *s)
{
    return extract32(s->regs[R_CFG1], 5, 4) + 1;
}

static uint32_t spi_sr(GnwSpiState *s)
{
    uint32_t sr = s->sr & (SR_STICKY | SR_TXC);
    unsigned fth = spi_fthlv(s) * spi_dsize_bytes(s);

    if (s->rx_len >= fth) {
        sr |= SR_RXP;
    }
    if (s->rx_len >= 4) {
        sr |= SR_RXWNE;
    } else {
        sr |= (s->rx_len & 3) << 13;            /* RXPLVL */
    }
    /* TX FIFO room; set out of reset too (SR resets to 0x1002). */
    if (s->rx_len <= GNW_SPI_FIFO - 4) {
        sr |= SR_TXP;
    }
    if ((sr & SR_RXP) && (sr & SR_TXP)) {
        sr |= SR_DXP;
    }
    sr |= (uint32_t)s->ctsize << 16;
    return sr;
}

static void spi_update_irq(GnwSpiState *s)
{
    qemu_set_irq(s->irq, (spi_sr(s) & s->regs[R_IER] & 0x3ff) != 0);
}

static uint8_t spi_exchange(GnwSpiState *s, uint8_t out)
{
    return s->xfer ? s->xfer(s->xfer_opaque, out) : 0xff;
}

/* CFG2.COMM: 0 full duplex, 1 simplex transmitter, 2 simplex receiver. */
static unsigned spi_comm(GnwSpiState *s)
{
    return extract32(s->regs[R_CFG2], 17, 2);
}

/* Clock one frame out and one in. */
static void spi_frame(GnwSpiState *s, uint32_t tx)
{
    unsigned n = spi_dsize_bytes(s);
    uint32_t rx = 0;

    for (unsigned b = 0; b < n; b++) {
        rx |= (uint32_t)spi_exchange(s, tx >> (8 * b)) << (8 * b);
    }
    if (spi_comm(s) == 1) {
        /* transmit only: the receiver is off */
    } else if (!((s->regs[R_CFG1] & CFG1_RXDMAEN) && s->dma &&
          gnw_dma_req_periph_to_mem(s->dma, s->req_rx, rx))) {
        for (unsigned b = 0; b < n; b++) {
            if (s->rx_len < GNW_SPI_FIFO) {
                s->rx[(s->rx_head + s->rx_len++) % GNW_SPI_FIFO] = rx >> (8 * b);
            } else {
                s->sr |= SR_OVR;
            }
        }
    }
    if (s->ctsize) {
        s->ctsize--;
        if (s->ctsize == 0) {
            s->sr |= SR_EOT | SR_TXTF | SR_TXC;
            s->running = false;
        }
    }
}

/*
 * Feed frames from the TX DMA stream while there is anything to send.
 * A simplex receiver clocks frames on its own (MOSI idles high) as long
 * as there is room for them.
 */
static void spi_pump(void *opaque)
{
    GnwSpiState *s = opaque;
    uint32_t item;

    if (spi_comm(s) == 2) {
        bool dma = (s->regs[R_CFG1] & CFG1_RXDMAEN) && s->dma &&
                   gnw_dma_req_active(s->dma, s->req_rx);
        while (s->running &&
               (dma || s->rx_len + spi_dsize_bytes(s) <= GNW_SPI_FIFO)) {
            spi_frame(s, 0xffffffff);
            dma = dma && gnw_dma_req_active(s->dma, s->req_rx);
        }
    }
    while (s->running && (s->regs[R_CFG1] & CFG1_TXDMAEN) && s->dma &&
           gnw_dma_req_mem_to_periph(s->dma, s->req_tx, &item)) {
        spi_frame(s, item);
    }
    spi_update_irq(s);
}

static void spi_start(GnwSpiState *s)
{
    s->running = true;
    s->ctsize = s->regs[R_CR2] & 0xffff;
    s->sr &= ~(SR_EOT | SR_TXTF | SR_TXC);
    spi_pump(s);
}

static uint64_t spi_read(void *opaque, hwaddr addr, unsigned size)
{
    GnwSpiState *s = opaque;
    hwaddr off = addr & ~3;
    uint32_t v;

    switch (off) {
    case 0x14:
        v = spi_sr(s);
        break;
    case 0x30: {                /* RXDR: pop as many bytes as accessed */
        v = 0;
        for (unsigned b = 0; b < size; b++) {
            uint8_t byte = 0;
            if (s->rx_len) {
                byte = s->rx[s->rx_head];
                s->rx_head = (s->rx_head + 1) % GNW_SPI_FIFO;
                s->rx_len--;
            }
            v |= (uint32_t)byte << (8 * b);
        }
        spi_pump(s);
        return v;
    }
    case 0x00:
        v = s->regs[R_CR1] & ~CR1_CSTART;
        if (s->running) {
            v |= CR1_CSTART;
        }
        break;
    default:
        v = s->regs[off / 4];
        break;
    }
    return v >> ((addr & 3) * 8);
}

static void spi_write(void *opaque, hwaddr addr, uint64_t value,
                      unsigned size)
{
    GnwSpiState *s = opaque;
    hwaddr off = addr & ~3;
    unsigned shift = (addr & 3) * 8;
    uint32_t mask = (size == 4 ? 0xffffffffu : ((1u << (size * 8)) - 1))
                    << shift;
    uint32_t val = (s->regs[off / 4] & ~mask) |
                   (((uint32_t)value << shift) & mask);

    switch (off) {
    case 0x00: {                /* CR1 */
        uint32_t old = s->regs[R_CR1];

        s->regs[R_CR1] = val & ~(CR1_CSTART | CR1_CSUSP);
        if (!(val & CR1_SPE)) {
            if (old & CR1_SPE) {
                s->running = false;
                s->rx_len = 0;
                s->rx_head = 0;
            }
        } else if ((val & CR1_CSUSP) && s->running) {
            s->running = false;
            s->sr |= SR_SUSP | SR_EOT;
        } else if ((val & CR1_CSTART) && !s->running) {
            spi_start(s);
        }
        break;
    }
    case 0x14:                  /* SR: read only */
        break;
    case 0x18:                  /* IFCR */
        s->sr &= ~(val & SR_STICKY);
        break;
    case 0x20: {                /* TXDR: one frame per data size */
        unsigned fb = spi_dsize_bytes(s);
        if (!(s->regs[R_CR1] & CR1_SPE)) {
            break;
        }
        for (unsigned b = 0; b + fb <= size; b += fb) {
            spi_frame(s, (uint32_t)(value >> (8 * b)));
        }
        break;
    }
    default:
        s->regs[off / 4] = val;
        break;
    }
    spi_update_irq(s);
}

static const MemoryRegionOps spi_ops = {
    .read = spi_read,
    .write = spi_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
    .impl.min_access_size = 1,
    .impl.max_access_size = 4,
};

static void gnw_spi_reset(DeviceState *dev)
{
    GnwSpiState *s = GNW_SPI(dev);

    memset(s->regs, 0, sizeof(s->regs));
    s->regs[R_CFG1] = 0x00070007;
    s->regs[R_CRCPOLY] = 0x107;
    s->sr = SR_TXC;
    s->rx_len = s->rx_head = 0;
    s->running = false;
    s->ctsize = 0;
    spi_update_irq(s);
}

static void gnw_spi_init(Object *obj)
{
    GnwSpiState *s = GNW_SPI(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->mmio, obj, &spi_ops, s, "spi", 0x400);
    sysbus_init_mmio(sbd, &s->mmio);
    sysbus_init_irq(sbd, &s->irq);
}

void gnw_spi_attach(GnwSpiState *s, GnwSpiXfer fn, void *opaque)
{
    s->xfer = fn;
    s->xfer_opaque = opaque;
}

void gnw_spi_connect_dma(GnwSpiState *s, GnwDmaState *dma, int req_rx,
                         int req_tx)
{
    s->dma = dma;
    s->req_rx = req_rx;
    s->req_tx = req_tx;
    dma->periph_kick = spi_pump;
    dma->periph_opaque = s;
}

static int spi_state_loaded(void *opaque, int version)
{
    GnwSpiState *s = opaque;
    return s->rx_head < 16 && s->rx_len <= 16 ? 0 : -EINVAL;
}
static const VMStateDescription vmstate_gnw_spi = {
    .name = "gnw_spi",
    .version_id = 1,
    .minimum_version_id = 1,
    .post_load = spi_state_loaded,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32_ARRAY(regs, GnwSpiState, 256),
        VMSTATE_UINT32(sr, GnwSpiState),
        VMSTATE_UINT8_ARRAY(rx, GnwSpiState, 16),
        VMSTATE_UINT32(rx_head, GnwSpiState),
        VMSTATE_UINT32(rx_len, GnwSpiState),
        VMSTATE_BOOL(running, GnwSpiState),
        VMSTATE_UINT16(ctsize, GnwSpiState),
        VMSTATE_END_OF_LIST()
    },
};

static void gnw_spi_class_init(ObjectClass *klass, const void *data)
{
    DEVICE_CLASS(klass)->vmsd = &vmstate_gnw_spi;
    device_class_set_legacy_reset(DEVICE_CLASS(klass), gnw_spi_reset);
}

static const TypeInfo gnw_spi_info = {
    .name = TYPE_GNW_SPI,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GnwSpiState),
    .instance_init = gnw_spi_init,
    .class_init = gnw_spi_class_init,
};

static void gnw_spi_register_types(void)
{
    type_register_static(&gnw_spi_info);
}

type_init(gnw_spi_register_types)
