"""Stock NOR read commands must deliver real bytes to firmware's crypto path."""
import pytest

from test_gwemu_desktop import Native, GWEMU

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
O = 0x52005000
PAYLOAD = bytes.fromhex("eb22228ac6cbfbdf8d30f2556189600f7867e6237ea9a3bb4d069d24bf6a6224")


@pytest.mark.parametrize("opcode,adsize", [
    (0x03, 2), (0x0b, 2), (0x3b, 2), (0x6b, 2), (0xbb, 2),
    (0x13, 3), (0x0c, 3), (0x3c, 3), (0x6c, 3), (0xbc, 3),
])
@pytest.mark.parametrize("width", [1, 4])
def test_stock_indirect_read_returns_flash_bytes(tmp_path, opcode, adsize, width):
    flash = bytearray(b"\xff" * (1024 * 1024))
    flash[0xfe000:0xfe000 + len(PAYLOAD)] = PAYLOAD
    (tmp_path / "flash.bin").write_bytes(flash)
    with Native(tmp_path) as n:
        n.write32(O, 1)
        n.write32(O + 0x40, len(PAYLOAD) - 1)
        n.write32(O + 0x100, 1 | (1 << 8) | (adsize << 12) | (3 << 24))
        n.write32(O + 0x110, opcode)
        n.write32(O + 0x48, 0xfe000)
        n.write32(O, (1 << 28) | 1)
        n.write32(O + 0x48, 0xfe000)
        got = bytearray()
        for _ in range(len(PAYLOAD) // width):
            verb = "readb" if width == 1 else "readl"
            got.extend(int(n.test(f"{verb} {O + 0x50:#x}"), 0).to_bytes(width, "little"))
        assert got == PAYLOAD, f"NOR command {opcode:#x} returned fabricated data"
        assert int(n.test(f"readb {O + 0x50:#x}"), 0) == 0xff
    assert (tmp_path / "flash.bin").read_bytes() == flash
