"""Real upstream SD protocol over the board's software and dedicated SPI."""
import subprocess
import binascii

import pytest

from test_gwemu_desktop import Native

GPIOB = 0x58020400
GPIOD = 0x58020c00
GPIOE = 0x58021000
SPI1 = 0x40013000


class SoftSPI:
    def __init__(self, machine, gaps=False):
        self.machine = machine
        self.gaps = gaps
        self.configure()

    def configure(self):
        m = self.machine
        for port, pins in ((GPIOB, (1, 2)), (GPIOE, (11,))):
            moder = m.read32(port)
            for pin in pins:
                moder = (moder & ~(3 << (pin * 2))) | (1 << (pin * 2))
            m.write32(port, moder)
        m.write32(GPIOD, m.read32(GPIOD) & ~(3 << 24))
        m.write32(GPIOB + 0x18, 1 << 18)  # CLK low
        self.select(False)

    def select(self, selected=True):
        self.machine.write32(GPIOE + 0x18, 1 << (11 if selected else 27))

    def bit(self, value):
        m = self.machine
        m.write32(GPIOB + 0x18, 1 << (1 if value else 17))
        m.write32(GPIOB + 0x18, 1 << 2)
        response = bool(m.read32(GPIOD + 0x10) & (1 << 12))
        m.write32(GPIOB + 0x18, 1 << 18)
        return response

    def byte(self, value=0xff):
        if self.gaps:
            self.select()
        result = 0
        for shift in range(7, -1, -1):
            result = result * 2 + self.bit(bool(value & (1 << shift)))
        if self.gaps:
            self.select(False)
        return result


class HardwareSPI:
    def __init__(self, machine):
        self.machine = machine

    def byte(self, value=0xff):
        self.machine.test(f"writeb {SPI1 + 0x20:#x} {value:#x}")
        assert self.machine.read32(SPI1 + 0x14) & 1  # RXP
        return self.machine.read32(SPI1 + 0x30) & 0xff


def card_machine(directory, wiring="ospi", card=True):
    m = Native(directory, "" if wiring == "default" else ",sd-wiring=" + wiring)
    if card:
        image = m.directory / "sd.img"
        if not image.exists():
            with image.open("wb") as f:
                f.truncate(64 * 1024 * 1024)
        m.args += ["-drive", f"if=sd,format=raw,file={image}"]
    return m


def command(spi, number, arg=0, extra=0):
    for _ in range(3):
        spi.byte()
    for value in [0x40 | number, *arg.to_bytes(4, "big"),
                  0x95 if number == 0 else 0x87 if number == 8 else 1]:
        spi.byte(value)
    for _ in range(12):
        response = spi.byte()
        if response != 0xff:
            return bytes([response] + [spi.byte() for _ in range(extra)])
    pytest.fail(f"CMD{number} produced no response")


def initialize(spi):
    assert command(spi, 0) == b"\x01"
    assert command(spi, 8, 0x1aa, extra=4) == b"\x01\x00\x00\x01\xaa"
    for _ in range(100):
        assert command(spi, 55)[0] in (0, 1)
        if command(spi, 41, 0x40000000) == b"\x00":
            break
    else:
        pytest.fail("SD failed to become ready")
    ocr = command(spi, 58, extra=4)
    assert ocr[0] == 0 and ocr[1] & 0x80
    assert command(spi, 16, 512) == b"\x00"


def read_block(spi, sector):
    assert command(spi, 17, sector * 512) == b"\x00"
    for _ in range(20):
        if spi.byte() == 0xfe:
            break
    else:
        pytest.fail("missing read token")
    block = bytes(spi.byte() for _ in range(512))
    spi.byte()
    spi.byte()
    return block


def write_block(spi, sector, block):
    assert command(spi, 24, sector * 512) == b"\x00"
    spi.byte()
    spi.byte(0xfe)
    for byte in block:
        spi.byte(byte)
    spi.byte()
    spi.byte()
    for _ in range(20):
        reply = spi.byte()
        if reply != 0xff:
            assert reply & 0x1f == 5
            break
    else:
        pytest.fail("missing write acceptance")
    for _ in range(20):
        if spi.byte() == 0xff:
            break


@pytest.mark.parametrize("wiring,gaps", [("default", False), ("spi1", False),
                                       ("ospi", False), ("ospi", True)])
def test_card_initialization_block_io_and_reopen(tmp_path, wiring, gaps):
    block = bytes((i * 37 + 11) & 255 for i in range(512))
    with card_machine(tmp_path, wiring) as machine:
        spi = SoftSPI(machine, gaps=gaps) if wiring == "ospi" else HardwareSPI(machine)
        if wiring == "ospi":
            spi.select()
            # The unselected dedicated peripheral must not consume card bytes.
            dedicated = HardwareSPI(machine)
            for byte in (0x40, 0, 0, 0, 0, 0x95):
                assert dedicated.byte(byte) == 0xff
        initialize(spi)
        assert read_block(spi, 7) == b"\x00" * 512
        write_block(spi, 7, block)
        assert read_block(spi, 7) == block
    assert (tmp_path / "sd.img").read_bytes()[7 * 512:8 * 512] == block
    with card_machine(tmp_path, wiring) as machine:
        spi = SoftSPI(machine, gaps=gaps) if wiring == "ospi" else HardwareSPI(machine)
        if wiring == "ospi":
            spi.select()
        initialize(spi)
        assert read_block(spi, 7) == block


def test_softspi_absent_deselected_and_gpio_modes(tmp_path):
    with card_machine(tmp_path, card=False) as machine:
        spi = SoftSPI(machine)
        assert spi.byte(0x40) == 0xff
        spi.select()
        assert [spi.byte(v) for v in (0x40, 0, 0, 0, 0, 0x95, 255, 255)] == [255] * 8
        # PD12 output loopback wins; bridge must not alter unrelated IDR pins.
        machine.write32(GPIOD, machine.read32(GPIOD) | (1 << 24))
        machine.write32(GPIOD + 0x18, 1 << 28)
        assert machine.read32(GPIOD + 0x10) & (1 << 12) == 0
        machine.write32(GPIOD + 0x18, 1 << 12)
        assert machine.read32(GPIOD + 0x10) & (1 << 12)


def test_partial_byte_cancel_reset_and_af_clocks(tmp_path):
    with card_machine(tmp_path) as machine:
        spi = SoftSPI(machine)
        spi.select()
        for bit in (0, 1, 0):
            spi.bit(bit)
        spi.select(False)
        assert spi.byte(0x40) == 0xff  # no deselected transfer
        spi.select()
        assert command(spi, 0) == b"\x01"
        for bit in (0, 1, 0):
            spi.bit(bit)
        machine.command("system_reset")
        spi.configure()
        # Alternate function clocks and a non-output CS must not clock SD.
        machine.write32(GPIOB, (machine.read32(GPIOB) & ~(3 << 4)) | (2 << 4))
        spi.select()
        for value in (0x40, 0, 0, 0, 0, 0x95):
            assert spi.byte(value) == 255
        spi.configure()
        spi.select()
        assert command(spi, 0) == b"\x01"


def test_duplicate_high_unrelated_pin_writes_and_mode_abort(tmp_path):
    with card_machine(tmp_path) as machine:
        spi = SoftSPI(machine)
        spi.select()
        for bit in (0, 1, 0):
            spi.bit(bit)
        # Disable MOSI output mid-byte. Partial command marker is discarded.
        original = machine.read32(GPIOB)
        machine.write32(GPIOB, original & ~(3 << 2))
        machine.write32(GPIOB, original)
        # Clock CMD0 with duplicate highs and unrelated pin changes. MISO
        # is stable before/after rising, including the eighth/last bit.
        def noisy_byte(value=255):
            rx = 0
            for shift in range(7, -1, -1):
                machine.write32(GPIOB + 0x18, 1 << (1 if value & (1 << shift) else 17))
                before = bool(machine.read32(GPIOD + 0x10) & (1 << 12))
                machine.write32(GPIOB + 0x18, 1 << 2)
                machine.write32(GPIOB + 0x18, 1 << 2)
                machine.write32(GPIOB + 0x18, 1 << 7)
                after = bool(machine.read32(GPIOD + 0x10) & (1 << 12))
                assert before == after
                rx = rx * 2 + after
                machine.write32(GPIOB + 0x18, 1 << 18)
            return rx
        spi.byte = noisy_byte
        initialize(spi)


def test_wiring_cannot_change_after_initialization(tmp_path):
    with card_machine(tmp_path) as machine:
        machine.serial += 1
        import json
        machine.qmp.sendall(json.dumps({"execute": "qom-set", "id": machine.serial,
                            "arguments": {"path": "/machine", "property": "sd-wiring",
                                          "value": "spi1"}}).encode() + b"\n")
        while True:
            reply = json.loads(machine.stream.readline())
            if reply.get("id") == machine.serial:
                assert "before machine initialization" in reply["error"]["desc"]
                break


@pytest.mark.parametrize("wiring", ["spi1", "ospi"])
def test_multiblock_cmd12_crc_and_card_registers(tmp_path, wiring):
    blocks = [bytes((i * 53 + sector * 29) & 255 for i in range(512))
              for sector in range(3)]
    with card_machine(tmp_path, wiring) as machine:
        spi = SoftSPI(machine, gaps=True) if wiring == "ospi" else HardwareSPI(machine)
        initialize(spi)
        for index, block in enumerate(blocks):
            write_block(spi, 7 + index, block)
        assert command(spi, 18, 7 * 512) == b"\0"
        for block in blocks:
            for _ in range(20):
                if spi.byte() == 0xfe:
                    break
            else:
                pytest.fail("missing multiblock token")
            data = bytes(spi.byte() for _ in range(512))
            crc = int.from_bytes(bytes([spi.byte(), spi.byte()]), "big")
            assert data == block
            assert crc == binascii.crc_hqx(data, 0)
        assert command(spi, 12) == b"\0"
        assert read_block(spi, 8) == blocks[1]
        for number in (9, 10):
            assert command(spi, number) == b"\0"
            for _ in range(20):
                if spi.byte() == 0xfe:
                    break
            else:
                pytest.fail(f"missing CMD{number} token")
            data = bytes(spi.byte() for _ in range(16))
            assert int.from_bytes(bytes([spi.byte(), spi.byte()]), "big") == binascii.crc_hqx(data, 0)


def test_pending_response_survives_byte_boundary_select_toggles(tmp_path):
    with card_machine(tmp_path) as machine:
        spi = SoftSPI(machine)
        spi.select()
        for v in (0x48, 0, 0, 1, 0xaa, 0x87):
            spi.byte(v)
        received = []
        for _ in range(9):
            spi.select(False)
            spi.select()
            received.append(spi.byte())
        assert received[:3] == [255, 255, 1]
        assert received[3:7] == [0, 0, 1, 0xaa]


def test_invalid_wiring_rejected_before_images_change(tmp_path):
    machine = card_machine(tmp_path, "invalid", card=False)
    before = machine.internal.read_bytes()
    try:
        result = subprocess.run(machine.args, capture_output=True, timeout=5)
        assert result.returncode != 0
        assert b"sd-wiring must be spi1 or ospi" in result.stderr
        assert machine.internal.read_bytes() == before
    finally:
        machine.__exit__()
