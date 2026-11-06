"""DAC/backlight hardware tests using synthetic images, with the CPU paused."""
import socket
import struct

import pytest

from harness import GnW

DAC1 = 0x40007400
DAC2 = 0x58003400
GPIOA = 0x58020000
GPIOD = GPIOA + 3 * 0x400
LTDC = 0x50001000


class MMIO:
    def __init__(self, gw, path):
        self.gw = gw
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(5)
        self.sock.connect(str(path))
        self.stream = self.sock.makefile("rwb", buffering=0)

    def command(self, text):
        self.stream.write((text + "\n").encode())
        response = self.stream.readline().decode().strip()
        assert response.startswith("OK"), response
        return response.split()[1:]

    def write(self, addr, value, size="l"):
        self.command(f"write{size} {addr:#x} {value:#x}")

    def read(self, addr, size="l"):
        return int(self.command(f"read{size} {addr:#x}")[0], 16)

    def close(self):
        self.stream.close()
        self.sock.close()


@pytest.fixture
def mmio(tmp_path):
    internal, external = tmp_path / "internal.bin", tmp_path / "external.bin"
    internal.write_bytes(struct.pack("<II", 0x20010000, 0x08000009) + b"\xfe\xe7")
    external.write_bytes(b"\xff" * 4096)
    gw = GnW(internal=str(internal), external=str(external))
    path = gw.tmp / "qtest.sock"
    gw.args += ["-qtest", f"unix:{path},server=on,wait=off",
                "-qtest-log", "/dev/null"]
    with gw:
        io = MMIO(gw, path)
        try:
            yield io
        finally:
            io.close()


@pytest.mark.parametrize("base", [DAC1, DAC2])
def test_dac_alignment_enable_and_readback(mmio, base):
    io = mmio
    io.write(base + 0x10, 0x80, "b")  # 8-bit -> 12-bit
    io.write(base + 0x18, 0xabc0, "w")  # channel 2, left aligned
    io.write(base, 0x10001)
    assert io.read(base + 0x2c) == 0x800
    assert io.read(base + 0x30) == 0xabc
    assert io.read(base + 0x08) == 0x800
    assert io.read(base + 0x0c) == 0x8000
    assert io.read(base + 0x10) == 0x80
    io.write(base + 0x08, 0xfff, "w")
    assert io.read(base + 0x2c) == 0xfff
    io.write(base + 0x2c, 0)  # DOR is read-only
    assert io.read(base + 0x2c) == 0xfff
    io.write(base, 0)
    io.write(base + 0x08, 0x123)
    assert io.read(base + 0x2c) == 0xfff  # disabled DAC holds DOR
    io.write(base, 1)
    assert io.read(base + 0x2c) == 0x123


@pytest.mark.parametrize("base", [DAC1, DAC2])
def test_dac_software_trigger_and_dual_write(mmio, base):
    io = mmio
    io.write(base, 0x00030003)  # EN, TEN, software TSEL=0 for both channels
    io.write(base + 0x20, 0x4560123)
    assert io.read(base + 0x2c) == io.read(base + 0x30) == 0
    io.write(base + 0x04, 1)
    assert io.read(base + 0x2c) == 0x123
    assert io.read(base + 0x30) == 0
    io.write(base + 0x04, 2)
    assert io.read(base + 0x30) == 0x456
    assert io.read(base + 0x04) == 0
    io.write(base, 0x10001)
    io.write(base + 0x24, 0xabc0def0)
    assert io.read(base + 0x2c) == 0xdef
    assert io.read(base + 0x30) == 0xabc
    io.write(base + 0x28, 0x8040, "w")
    assert io.read(base + 0x2c) == 0x400
    assert io.read(base + 0x30) == 0x800
    io.gw.qmp.cmd("system_reset")
    assert io.read(base) == 0
    assert io.read(base + 0x08) == 0
    assert io.read(base + 0x2c) == io.read(base + 0x30) == 0


def configure_panel(io):
    # Enable both panel rails, set PA4 to analog (the reset mode).
    io.write(GPIOD, 0x100 | 0x04)  # PD4 and PD1 output
    io.write(GPIOD + 0x14, 1 << 4)
    io.write(LTDC + 0x0c, 0)
    io.write(LTDC + 0x10, (2 << 16) | 2)
    io.write(LTDC + 0x14, (3 << 16) | 3)
    io.write(LTDC + 0x2c, 0x4080c0)
    # One opaque RGB888 layer over the background, only in column 0.
    io.write(0x24000000, 0x00102030)
    layer = LTDC + 0x84
    for off, value in ((0, 1), (4, (1 << 16) | 1), (8, (1 << 16) | 1),
                       (0x10, 1), (0x14, 255), (0x1c, 4 << 8),
                       (0x28, 0x24000000), (0x2c, (3 << 16) | 6),
                       (0x30, 1)):
        io.write(layer + off, value)
    io.write(LTDC + 0x18, 1)
    io.write(LTDC + 0x24, 1)


def test_backlight_scales_composed_pixels_and_power_gates(mmio):
    io = mmio
    configure_panel(io)
    io.write(DAC1, 1)
    for level in (0, 2048, 4095):
        io.write(DAC1 + 8, level)
        image = io.gw.frame().convert("RGB")
        assert image.size == (2, 2)
        assert image.getpixel((0, 0)) == tuple(c * level // 4095 for c in (16, 32, 48))
        assert image.getpixel((1, 1)) == tuple(c * level // 4095 for c in (64, 128, 192))
        assert io.read(0x24000000) == 0x00102030
    io.write(DAC1, 0)
    assert not any(io.gw.frame().convert("RGB").tobytes())
    io.write(DAC1, 1)
    assert any(io.gw.frame().convert("RGB").tobytes())
    io.write(GPIOD + 0x14, 0)
    assert not any(io.gw.frame().convert("RGB").tobytes())
    io.write(GPIOD + 0x14, 1 << 4)
    assert any(io.gw.frame().convert("RGB").tobytes())


def test_gpio_backlight_overrides_dac(mmio):
    io = mmio
    configure_panel(io)
    moder = io.read(GPIOA)
    io.write(GPIOA, (moder & ~(3 << 8)) | (1 << 8))
    io.write(GPIOA + 0x14, 1 << 4)
    assert io.gw.frame().convert("RGB").getpixel((1, 1)) == (64, 128, 192)
    io.write(GPIOA + 0x18, 1 << 20)  # BSRR reset PA4
    assert not any(io.gw.frame().convert("RGB").tobytes())
    io.write(DAC1, 1)
    io.write(DAC1 + 8, 4095)
    assert not any(io.gw.frame().convert("RGB").tobytes())
    io.write(GPIOA, moder)
    assert io.gw.frame().convert("RGB").getpixel((1, 1)) == (64, 128, 192)
