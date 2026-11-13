"""Device contracts inherited from hardware, rather than legacy quirks."""
import pytest

from test_gwemu_desktop import Native, GWEMU

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
P = 0x58024800
O = 0x52005000


def nor_command(n, opcode, address=None, length=1, read=False):
    n.write32(O, (int(read) << 28) | 1)
    n.write32(O + 0x40, length - 1)
    n.write32(O + 0x100, 1 if address is None else
              1 | (1 << 8) | (2 << 12) | (3 << 24))
    n.write32(O + 0x110, opcode)
    if address is not None:
        n.write32(O + 0x48, address)


def program(n, address, data, enable=True):
    if enable:
        nor_command(n, 6)
    nor_command(n, 0x38, address, len(data))
    for byte in data:
        n.test(f"writeb {O + 0x50:#x} {byte:#x}")


def array_read(n, address, size):
    nor_command(n, 0x6b, address, size, read=True)
    return bytes(int(n.test(f"readb {O + 0x50:#x}"), 0) for _ in range(size))


def test_nor_program_requires_write_enable(tmp_path):
    with Native(tmp_path) as n:
        program(n, 0x100, b"\x00", enable=False)
        assert array_read(n, 0x100, 1) == b"\xff"


def test_nor_program_cannot_raise_bits_without_erase_and_persists(tmp_path):
    with Native(tmp_path) as n:
        program(n, 0x100, b"\x00")
        program(n, 0x100, b"\xff")
        assert array_read(n, 0x100, 1) == b"\x00"
    assert (tmp_path / 'flash.bin').read_bytes()[0x100] == 0


def test_nor_program_wraps_within_page_and_consumes_write_enable(tmp_path):
    with Native(tmp_path) as n:
        program(n, 0x1ff, b"\x12\x34")
        assert array_read(n, 0x1ff, 2) == b"\x12\xff"
        assert array_read(n, 0x100, 1) == b"\x34"
        program(n, 0x101, b"\x00", enable=False)
        assert array_read(n, 0x101, 1) == b"\xff"


def test_nor_array_read_does_not_clear_write_enable(tmp_path):
    with Native(tmp_path) as n:
        nor_command(n, 6)
        assert array_read(n, 0x100, 1) == b"\xff"
        nor_command(n, 5, read=True)
        assert int(n.test(f"readb {O + 0x50:#x}"), 0) & 2
        program(n, 0x100, b"\x00", enable=False)
        assert array_read(n, 0x100, 1) == b"\x00"


def test_nor_sector_erase_requires_write_enable(tmp_path):
    flash = bytearray(b"\xff" * (1024 * 1024))
    flash[0x100] = 0
    (tmp_path / 'flash.bin').write_bytes(flash)
    with Native(tmp_path) as n:
        nor_command(n, 0x20, 0x100)
        assert array_read(n, 0x100, 1) == b"\x00"
        nor_command(n, 6)
        nor_command(n, 0x20, 0x100)
        assert array_read(n, 0x100, 1) == b"\xff"


def test_pwr_cssf_clears_status_and_self_clears(tmp_path):
    with Native(tmp_path) as n:
        assert n.read32(P + 0x10) & 0x40
        n.write32(P + 0x10, 1)
        assert n.read32(P + 0x10) == 0x41  # Hardware status is read-only.
        n.write32(P + 0x10, 0x241)
        assert n.read32(P + 0x10) == 1  # CSSF clears STOPF/SBF, not controls.


def test_pwr_wakeup_clear_is_write_one_and_self_clears(tmp_path):
    with Native(tmp_path) as n:
        assert n.read32(P + 0x24) == 1  # Model's normal POWER/Standby boot.
        n.write32(P + 0x20, 2)
        assert n.read32(P + 0x24) == 1
        assert n.read32(P + 0x20) == 0
        n.write32(P + 0x20, 1)
        assert n.read32(P + 0x24) == n.read32(P + 0x20) == 0
        n.write32(P + 0x24, 0x3f)
        assert n.read32(P + 0x24) == 0  # Flags cannot be set by software.


def test_pwr_byte_write_uses_the_addressed_lane(tmp_path):
    with Native(tmp_path) as n:
        n.write32(P + 0x10, 1)
        assert int(n.test(f"readb {P + 0x11:#x}"), 0) == 0
        n.test(f"writeb {P + 0x11:#x} 2")  # CSSF, preserving RETDS_CD.
        assert n.read32(P + 0x10) == 1
        n.test(f"writeb {P + 0x21:#x} 1")  # Not WKUPC1.
        assert n.read32(P + 0x24) == 1


@pytest.mark.parametrize('index,bits', [(0, 32), (1, 16), (2, 16), (3, 32),
                                        (4, 16), (5, 16), (6, 16), (7, 16), (8, 16)])
def test_timer_counter_and_reload_width(tmp_path, index, bits):
    with Native(tmp_path) as n:
        base = 0x40000000 + index * 0x400
        for offset in (0x24, 0x2c):
            n.write32(base + offset, 0x1234ffff)
            assert n.read32(base + offset) == 0x1234ffff & ((1 << bits) - 1)


D = 0x40007400


def test_dac_software_trigger_transfers_only_selected_enabled_channel(tmp_path):
    with Native(tmp_path) as n:
        n.write32(D, 3 | (3 << 16))
        n.write32(D + 8, 0xabc)
        n.write32(D + 0x14, 0x123)
        assert n.read32(D + 0x2c) == n.read32(D + 0x30) == 0
        n.write32(D + 4, 1)
        assert n.read32(D + 0x2c) == 0xabc
        assert n.read32(D + 0x30) == n.read32(D + 4) == 0
        n.write32(D + 4, 2)
        assert n.read32(D + 0x30) == 0x123


def test_dac_disabled_output_holds_until_enable(tmp_path):
    with Native(tmp_path) as n:
        n.write32(D, 1)
        n.write32(D + 8, 0xabc)
        n.write32(D, 0)
        n.write32(D + 8, 0x456)
        assert n.read32(D + 0x2c) == 0xabc
        n.write32(D + 0x2c, 0)
        assert n.read32(D + 0x2c) == 0xabc  # Output is read-only.
        n.write32(D, 1)
        assert n.read32(D + 0x2c) == 0x456


@pytest.mark.parametrize('offset,value,expected', [
    (0x20, 0x01230789, (0x789, 0x123)),
    (0x24, 0x12307890, (0x789, 0x123)),
    (0x28, 0x1278, (0x780, 0x120)),
])
def test_dac_dual_holding_registers_update_channel_aliases(tmp_path, offset, value, expected):
    with Native(tmp_path) as n:
        n.write32(D, 1 | (1 << 16))
        n.write32(D + offset, value)
        assert (n.read32(D + 0x2c), n.read32(D + 0x30)) == expected
        assert (n.read32(D + 8), n.read32(D + 0x14)) == expected
        assert n.read32(D + 0x20) == expected[0] | (expected[1] << 16)


def backlight(n, mode=1, value=1):
    n.write32(0x58020000, (n.read32(0x58020000) & ~(3 << 8)) | (mode << 8))
    n.write32(0x58020014, value << 4)


@pytest.mark.parametrize('format,raw,expected', [
    (0, b'\x00\x00\xff\xff', b'\xff\x00\x00'),
    (1, b'\x00\x00\xff', b'\xff\x00\x00'),
    (2, b'\x00\xf8', b'\xff\x00\x00'),
    (3, b'\x00\xfc', b'\xff\x00\x00'),
    (4, b'\x00\xff', b'\xff\x00\x00'),
    (5, b'\x11', b'\xff\x00\x00'),
    (6, b'\x81', b'\x88\x00\x00'),
    (7, b'\x11\x80', b'\x80\x00\x00'),
])
def test_ltdc_layer1_pixel_formats(tmp_path, format, raw, expected):
    from test_gwemu_savestate_peripherals import setup_display, screen, L, FB
    with Native(tmp_path) as n:
        backlight(n)
        data = raw * (32 * 16)
        n.test(f'write {FB:#x} {len(data)} 0x{data.hex()}')
        setup_display(n)
        n.write32(L + 0x94, format)
        n.write32(L + 0xb0, (32 * len(raw)) << 16 | (32 * len(raw) + 3))
        n.write32(L + 0x98, 255)
        n.write32(L + 0xa0, 0x607)
        n.write32(L + 0xc4, 0x11ff0000)
        n.write32(L + 0x24, 1)
        assert screen(n, tmp_path / 'screen.ppm', expected)[:3] == expected


def test_backlight_digital_and_dac_controls_paused_scanout(tmp_path):
    from test_gwemu_savestate_peripherals import fill, setup_display, screen, FB
    with Native(tmp_path) as n:
        backlight(n)
        fill(n, FB, 0xffff)
        setup_display(n)
        screen(n, tmp_path / 'full.ppm', b'\xff\xff\xff')
        backlight(n, value=0)
        screen(n, tmp_path / 'off.ppm', b'\0\0\0')
        n.write32(D, 1)
        n.write32(D + 8, 0x800)
        backlight(n, mode=3)
        screen(n, tmp_path / 'half.ppm', b'\x7f\x7f\x7f')
        n.write32(D + 8, 0)
        screen(n, tmp_path / 'analog-off.ppm', b'\0\0\0')


@pytest.mark.parametrize('enable,first,second,expected', [
    (False, b'\x00\x00', None, b'\xff\xff'),
    (True, b'\x00\x12', b'\xff\xff', b'\x00\x12'),
])
def test_timed_nor_program_obeys_write_enable_bits_and_page_wrap(tmp_path, enable, first, second, expected):
    (tmp_path / 'flash.bin').write_bytes(b'\xff' * (64 * 1024 * 1024))
    n = Native(tmp_path, globals=['gnw-h7b0-ospi.timing-mode=on'])
    i = n.args.index('gnw-h7b0-soc.extflash-chip=c2-25-34')
    n.args[i] = 'gnw-h7b0-soc.extflash-chip=c2-25-3a'
    with n:
        n.command('qom-set', {'path': '/machine/soc/octospi1',
                             'property': 'x-kernel-clock-hz', 'value': 10_000_000})
        n.command('cont')
        for data in (first, second):
            if data is None:
                continue
            if enable:
                nor_command(n, 6)
                n.step()
            n.write32(O, 1)
            n.write32(O + 0x40, len(data) - 1)
            n.write32(O + 0x100, 1 | (1 << 8) | (3 << 12) | (3 << 24))
            n.write32(O + 0x110, 0x3e)
            n.write32(O + 0x48, 0x1ff)
            for byte in data:
                n.test(f'writeb {O + 0x50:#x} {byte:#x}')
            n.step()
            assert n.read32(O + 0x20) & 0x20 == 0  # BUSY cleared at NCS release.
        # qtest XIP access models an external programmer, avoiding read FIFO.
        n.write32(O, (3 << 28) | 1)
        assert int(n.test('readb 0x900001ff'), 0) == expected[0]
        assert int(n.test('readb 0x90000100'), 0) == expected[1]
        assert int(n.test('readb 0x90000200'), 0) == 0xff

