"""Receive state required by the STM32H7 HAL's byte-oriented SD path."""
import hashlib
import pytest

from test_gwemu_desktop import GWEMU, Native
from test_gwemu_savestate import OPT_IN, backed, prop, migrate
from test_gwemu_softspi import HardwareSPI, card_machine, command, initialize

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
SPI = 0x40013000
RXP = 1
RXPLVL_ONE = 1 << 13
RX_LEVEL = (3 << 13) | (1 << 15)


def receive(native):
    native.test(f"writeb {SPI + 0x20:#x} 0xff")


def test_byte_receive_reports_level_and_consumes_on_rxdr(tmp_path):
    with Native(tmp_path) as n:
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        receive(n)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == RXP | RXPLVL_ONE
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0xff
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        receive(n)
        n.read32(SPI + 0x30)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0


def test_disable_and_reset_clear_receive_availability(tmp_path):
    with Native(tmp_path) as n:
        n.write32(SPI, 1)
        receive(n)
        n.write32(SPI, 0)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        receive(n)
        n.command("system_reset")
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0


def test_unread_receive_and_irq_restore_then_consume(tmp_path):
    state = tmp_path / "receive.state"
    with backed(tmp_path / "session", OPT_IN) as n:
        n.write32(SPI + 0x10, RXP)
        receive(n)
        assert n.read32(0xe000e204) & 8  # SPI1 IRQ35 pending
        prop(n, "save-state", state)
        n.read32(SPI + 0x30)
        n.write32(0xe000e284, 8)
        assert n.read32(0xe000e204) & 8 == 0
        prop(n, "load-state", state)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == RXP | RXPLVL_ONE
        assert n.read32(0xe000e204) & 8
        assert n.read32(SPI + 0x30) == 0xff
        n.write32(0xe000e284, 8)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        assert n.read32(0xe000e204) & 8 == 0


def test_two_unread_bytes_keep_wire_order(tmp_path):
    # CMD8 returns a distinctive 0x01,0xaa tail after two zero bytes.
    with card_machine(tmp_path, "spi1") as n:
        spi = HardwareSPI(n)
        assert command(spi, 0) == b"\x01"
        assert command(spi, 8, 0x1aa) == b"\x01"
        assert spi.byte() == spi.byte() == 0
        receive(n)
        receive(n)
        assert n.read32(SPI + 0x14) & RX_LEVEL == 2 << 13
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0x01
        assert n.read32(SPI + 0x14) & RX_LEVEL == RXPLVL_ONE
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0xaa
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0


def test_cached_status_full_duplex_pump_keeps_all_received_bytes(tmp_path):
    # Actual RetroGo spi_xfer snapshots SR before TXDR, then consumes RXDR
    # using the old status. At most one previous byte is pending before TX.
    with card_machine(tmp_path, "spi1") as n:
        packet = bytes([0x40, 0, 0, 0, 0, 0x95])
        sent, received = 0, bytearray()
        for _ in range(len(packet) + 3):
            sr = n.read32(SPI + 0x14)
            if sent < len(packet) and sr & 2:
                n.test(f"writeb {SPI + 0x20:#x} {packet[sent]:#x}")
                sent += 1
            if sr & RXP:
                received.append(int(n.test(f"readb {SPI + 0x30:#x}"), 0))
            if len(received) == len(packet):
                break
        assert len(received) == len(packet), "unread RX was overwritten by the next TXDR"
        spi = HardwareSPI(n)
        for _ in range(12):
            response = spi.byte()
            if response != 0xff:
                break
        assert response == 1  # Actual SSI card received the complete CMD0.


def queue_cmd8_tail(n):
    spi = HardwareSPI(n)
    assert command(spi, 0) == b"\x01"
    assert command(spi, 8, 0x1aa) == b"\x01"
    assert spi.byte() == spi.byte() == 0
    n.write32(SPI + 0x10, RXP)
    receive(n)
    receive(n)


def test_nonempty_receive_fifo_migration_preserves_byte_order_and_irq(tmp_path):
    # Instant states intentionally reject SD. Raw QEMU migration can carry the
    # synthetic card and its queued response to exercise SPI VMState itself.
    state = tmp_path / "fifo.migration"
    with card_machine(tmp_path / "source", "spi1") as n:
        queue_cmd8_tail(n)
        # Finish the SSI card's response state before migration; its upstream
        # post-load guard rejects the transient response_pos==response length.
        receive(n)
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0x01
        migrate(n, "migrate", state)
    target = card_machine(tmp_path / "target", "spi1")
    target.args += ["-incoming", "defer"]
    with target as n:
        try:
            migrate(n, "migrate-incoming", state)
        except EOFError:
            raise AssertionError(n.process.stderr.read().decode())
        assert n.read32(SPI + 0x14) & RX_LEVEL == 2 << 13
        assert n.read32(0xe000e204) & 8
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0xaa
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0xff
        n.write32(0xe000e284, 8)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        assert n.read32(0xe000e204) & 8 == 0


def test_receive_fifo_is_bounded_and_wraps_without_reordering(tmp_path):
    machine = card_machine(tmp_path, "spi1")
    with (tmp_path / "sd.img").open("r+b") as card:
        card.write(bytes(range(256)) * 2)
    with machine as n:
        spi = HardwareSPI(n)
        initialize(spi)
        assert command(spi, 17) == b"\0"
        for _ in range(20):
            if spi.byte() == 0xfe:
                break
        else:
            pytest.fail("missing actual data token")
        for _ in range(20):
            receive(n)
        assert n.read32(SPI + 0x14) & RX_LEVEL == 1 << 15
        prefix = bytes(int(n.test(f"readb {SPI + 0x30:#x}"), 0) for _ in range(8))
        assert prefix == bytes(range(8))
        for _ in range(8):
            receive(n)
        tail = bytes(int(n.test(f"readb {SPI + 0x30:#x}"), 0) for _ in range(16))
        assert tail == bytes([*range(8, 16), *range(20, 28)])
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0


@pytest.mark.parametrize("field,value", [("head", 16), ("count", 17)])
def test_malformed_receive_fifo_migration_is_rejected(tmp_path, field, value):
    state = tmp_path / "bad-fifo.state"
    with backed(tmp_path / "session", OPT_IN) as n:
        receive(n)
        prop(n, "save-state", state)
        data = bytearray(state.read_bytes())
        start, end = 280, None
        name = b"gnw-h7b0-spi"
        while (start := data.find(name, start)) >= 0:
            candidate = start + len(name)
            if (data[candidate + 4:candidate + 8] == b"\0\0\0\3" and
                    int.from_bytes(data[candidate + 8 + 0x14:candidate + 8 + 0x18], "big") & RXP):
                end = candidate  # Target unread SPI1, not the empty SPI2 section.
                break
            start = candidate
        assert end is not None
        fifo = end + 8 + 0x400 + 1  # regs, dma_pending, then version3 FIFO
        data[fifo + 16 + (field == "count")] = value
        data[248:280] = hashlib.sha256(data[280:]).digest()
        state.write_bytes(data)
        with pytest.raises(AssertionError, match="state|State|Invalid|load"):
            prop(n, "load-state", state)
        assert not n.command("query-status")["running"]
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        n.command("system_reset")
        receive(n)
        assert n.read32(SPI + 0x30) == 0xff


def test_version2_unread_byte_migration_converts_to_fifo(tmp_path):
    state = tmp_path / "v2-spi.state"
    with backed(tmp_path / "session", OPT_IN) as n:
        n.write32(SPI + 0x10, RXP)
        receive(n)
        prop(n, "save-state", state)
        data = bytearray(state.read_bytes())
        positions = []
        start = 280
        name = b"gnw-h7b0-spi"
        while (start := data.find(name, start)) >= 0:
            end = start + len(name)
            if data[end + 4:end + 8] == b"\0\0\0\3":
                positions.append(end)
            start = end
        assert len(positions) == 2  # SPI1 and SPI2 device sections.
        for end in reversed(positions):
            fifo = end + 8 + 0x400 + 1
            del data[fifo:fifo + 18]  # Version2 ended after dma_pending.
            data[end + 4:end + 8] = b"\0\0\0\2"
        data[240:248] = (len(data) - 280).to_bytes(8, "big")
        data[248:280] = hashlib.sha256(data[280:]).digest()
        state.write_bytes(data)
        n.read32(SPI + 0x30)
        n.write32(0xe000e284, 8)
        prop(n, "load-state", state)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == RXP | RXPLVL_ONE
        assert int(n.test(f"readb {SPI + 0x30:#x}"), 0) == 0xff
        n.write32(0xe000e284, 8)
        assert n.read32(SPI + 0x14) & (RXP | RX_LEVEL) == 0
        assert n.read32(0xe000e204) & 8 == 0
