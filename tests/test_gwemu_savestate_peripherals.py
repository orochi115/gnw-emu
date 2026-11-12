"""Snapshots retain codec streams and captured scanout, not only registers."""
import struct
import time

import pytest

from test_gwemu_desktop import GWEMU
from test_gwemu_savestate import OPT_IN, backed, prop

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason='build gwemu first')
J = 0x52003000
L = 0x50001000
FB = 0x24010000
FB2 = 0x24018000


def feed(n, data):
    for i in range(0, len(data), 4):
        n.write32(J + 0x40, int.from_bytes(data[i:i + 4].ljust(4, b'\0'), 'little'))


def start_encode(n, width=8, height=8):
    n.write32(J + 4, height << 16 | 2)
    n.write32(J + 12, width << 16)
    n.write32(J, 1)


def drain(n):
    result = bytearray()
    while n.read32(J + 0x34) & 16:
        result += struct.pack('<I', n.read32(J + 0x44))
        assert len(result) < 64 * 1024
    return bytes(result)


def pixels(width=8, height=8):
    return bytes(v for i in range(width * height) for v in ((i * 17) & 255, 128, 128))


def encoded(n):
    start_encode(n)
    feed(n, pixels())
    data = drain(n)
    assert data[:2] == b'\xff\xd8' and b'\xff\xd9' in data
    return data


def start_decode(n):
    n.write32(J + 4, 8)
    n.write32(J, 1)


def wait_decode(n):
    deadline = time.monotonic() + 3
    while not n.read32(J + 0x34) & 0x20:
        assert time.monotonic() < deadline, 'JPEG completion timed out'
        time.sleep(.001)


def test_jpeg_partial_encode_input_continues(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        expected = encoded(n)
        start_encode(n)
        feed(n, pixels()[:80])
        prop(n, 'save-state', tmp_path / 'state')
        feed(n, pixels()[80:])
        assert drain(n) == expected
        prop(n, 'load-state', tmp_path / 'state')
        feed(n, pixels()[80:])
        assert drain(n) == expected


def test_jpeg_encoded_output_cursor_rewinds(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        expected = encoded(n)
        start_encode(n)
        feed(n, pixels())
        prefix = struct.pack('<I', n.read32(J + 0x44))
        prop(n, 'save-state', tmp_path / 'state')
        assert prefix + drain(n) == expected
        prop(n, 'load-state', tmp_path / 'state')
        assert prefix + drain(n) == expected


def test_jpeg_partial_decode_input_continues(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        data = encoded(n)
        start_decode(n)
        feed(n, data)
        wait_decode(n)
        expected = drain(n)
        assert any(expected)
        start_decode(n)
        feed(n, data[:100])
        prop(n, 'save-state', tmp_path / 'state')
        feed(n, data[100:])
        wait_decode(n)
        assert drain(n) == expected
        prop(n, 'load-state', tmp_path / 'state')
        feed(n, data[100:])
        wait_decode(n)
        assert drain(n) == expected


def test_jpeg_decoded_planes_and_cursor_reopen(tmp_path):
    directory = tmp_path / 'session'
    state = tmp_path / 'state'
    with backed(directory, OPT_IN) as n:
        data = encoded(n)
        start_decode(n)
        feed(n, data)
        wait_decode(n)
        prefix = n.read32(J + 0x44)
        prop(n, 'save-state', state)
        expected = drain(n)
        assert prefix or any(expected)
        start_decode(n)
        prop(n, 'load-state', state)
        assert drain(n) == expected
    with backed(directory, OPT_IN) as n:
        prop(n, 'load-state', state)
        assert drain(n) == expected


def fill(n, address, value, width=32, height=16, palette=False):
    data = bytes([value]) * (width * height) if palette else struct.pack('<H', value) * (width * height)
    n.test(f'write {address:#x} {len(data)} 0x{data.hex()}')


def setup_display(n, address=FB, width=32, height=16, palette=False):
    stride = width * (1 if palette else 2)
    for offset, value in ((0x18, 1), (0x84, 1), (0x94, 5 if palette else 2),
                          (0x98, 255), (0x88, width << 16), (0x8c, height << 16),
                          (0xac, address), (0xb0, stride << 16 | (stride + 3)),
                          (0xb4, height)):
        n.write32(L + offset, value)
    n.write32(L + 0x24, 1)


def screen(n, path, color=None):
    deadline = time.monotonic() + 3
    while True:
        n.command('screendump', {'filename': str(path)})
        data = path.read_bytes().split(b'\n', 3)
        if data[1] == b'64 32' and (color is None or data[3][:3] == color):
            return data[3]
        assert time.monotonic() < deadline, f'wrong display {data[:3]} {data[3][:3]}'
        time.sleep(.005)


def test_ltdc_captured_pixels_survive_ram_overwrite_and_reopen(tmp_path):
    directory = tmp_path / 'session'
    state = tmp_path / 'state'
    with backed(directory, OPT_IN) as n:
        fill(n, FB, 0xf800)
        setup_display(n)
        expected = screen(n, tmp_path / 'red.ppm', b'\xff\0\0')
        fill(n, FB2, 0x001f)
        fill(n, FB, 0x001f)  # captured frame remains red though RAM is now blue
        prop(n, 'save-state', state)
        n.write32(L + 0xac, FB2)
        n.write32(L + 0x24, 1)
        screen(n, tmp_path / 'blue.ppm', b'\0\0\xff')
        prop(n, 'load-state', state)
        assert screen(n, tmp_path / 'restored.ppm') == expected
        n.write32(L + 0xac, FB2)
        n.write32(L + 0x24, 1)
        screen(n, tmp_path / 'fresh.ppm', b'\0\0\xff')
    with backed(directory, OPT_IN) as n:
        prop(n, 'load-state', state)
        assert screen(n, tmp_path / 'reopened.ppm') == expected


def test_ltdc_pending_vbr_shadow_and_palette_restore(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        fill(n, FB, 1, palette=True)
        fill(n, FB2, 2, palette=True)
        n.write32(L + 0xc4, 1 << 24 | 0xff0000)
        n.write32(L + 0xc4, 2 << 24 | 0x00ff00)
        setup_display(n, palette=True)
        expected = screen(n, tmp_path / 'red.ppm', b'\xff\0\0')
        n.command('cont')
        n.step(5_000_000)
        n.command('stop')
        n.write32(L + 0xac, FB2)
        n.write32(L + 0x24, 2)
        prop(n, 'save-state', tmp_path / 'state')
        n.write32(L + 0xc4, 1 << 24 | 0x0000ff)
        fill(n, FB2, 0x07e0)
        n.write32(L + 0x94, 2)
        n.write32(L + 0xb0, 64 << 16 | 67)
        n.write32(L + 0x24, 1)
        screen(n, tmp_path / 'green.ppm', b'\0\xff\0')
        prop(n, 'load-state', tmp_path / 'state')
        assert n.read32(L + 0xac) == FB2 and n.read32(L + 0x24) & 2
        assert screen(n, tmp_path / 'restored.ppm') == expected
        n.write32(L + 0x3c, 15)
        n.command('cont')
        n.step(11_000_000)
        assert n.read32(L + 0x24) & 2
        assert n.read32(L + 0x38) & 8 == 0
        n.step(1_000_000)
        assert n.read32(L + 0x24) & 2 == 0
        assert n.read32(L + 0x38) & 8
        n.command('stop')
        n.write32(L + 0xac, FB)
        n.write32(L + 0x24, 1)
        screen(n, tmp_path / 'palette-restored.ppm', b'\xff\0\0')


def worker_jpeg():
    # A real 1280x1024 constant-color JPEG, generated once with Pillow13.
    # APP padding forces the existing >256KiB worker path; decoded planes
    # are genuinely large, so reset/START occurs while it is computing.
    from pathlib import Path
    data = (Path(__file__).parent / 'fixtures/gwemu-savestate-worker.jpg').read_bytes()
    app = b'\xff\xef' + struct.pack('>H', 60002) + b'\0' * 60000
    return data[:2] + app * 5 + data[2:]


def feed_worker(n, data):
    # Bound socket buffering while keeping large input tests inexpensive.
    words = [int.from_bytes(data[i:i + 4].ljust(4, b'\0'), 'little')
             for i in range(0, len(data), 4)]
    for i in range(0, len(words), 128):
        batch = words[i:i + 128]
        n.qtest.sendall(''.join(f'writel {J + 0x40:#x} {v:#x}\n' for v in batch).encode())
        for _ in batch:
            assert n.test_stream.readline().strip() == b'OK'


def output_words(n, count=32):
    return [n.read32(J + 0x44) for _ in range(count)]


def test_jpeg_worker_save_settles_large_result_and_preserves_cursor(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        start_decode(n)
        feed_worker(n, worker_jpeg())
        prop(n, 'save-state', tmp_path / 'state')
        assert n.read32(J + 0x34) & 0x20
        assert n.read32(J + 12) >> 16 == 1280
        expected = output_words(n)
        assert any(expected)
        start_decode(n)
        prop(n, 'load-state', tmp_path / 'state')
        assert output_words(n) == expected


@pytest.mark.parametrize('action', ['start', 'load'])
def test_jpeg_old_worker_cannot_publish_after_restart_or_load(tmp_path, action):
    with backed(tmp_path / 'session', OPT_IN) as n:
        data = encoded(n)
        start_decode(n)
        feed(n, data)
        wait_decode(n)
        prop(n, 'save-state', tmp_path / 'ready')
        expected = output_words(n)
        start_decode(n)
        feed_worker(n, worker_jpeg())
        if action == 'load':
            prop(n, 'load-state', tmp_path / 'ready')
            time.sleep(.03)  # old worker would have completed by now
            assert output_words(n) == expected
        else:
            start_decode(n)
            feed(n, data[:100])
            prop(n, 'save-state', tmp_path / 'partial')
            time.sleep(.03)
            assert n.read32(J + 0x34) & 0x20 == 0
            prop(n, 'load-state', tmp_path / 'partial')
            feed(n, data[100:])
            wait_decode(n)
            assert output_words(n) == expected
        # A new operation remains usable after worker quiesce/load.
        start_decode(n)
        feed(n, data)
        wait_decode(n)
        assert output_words(n) == expected


def test_ltdc_uninitialized_snapshot_discards_future_surface(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        path = tmp_path / 'initial.ppm'
        n.command('screendump', {'filename': str(path)})
        initial = path.read_bytes()
        prop(n, 'save-state', tmp_path / 'state')
        fill(n, FB, 0xf800)
        setup_display(n)
        screen(n, tmp_path / 'future.ppm', b'\xff\0\0')
        prop(n, 'load-state', tmp_path / 'state')
        n.command('screendump', {'filename': str(path)})
        assert path.read_bytes() == initial


@pytest.mark.parametrize('device,kind', [('jpeg', 'length'), ('jpeg', 'dimension'),
                                        ('ltdc', 'dimension')])
def test_dynamic_state_rejects_invalid_bounds_and_recovers(tmp_path, device, kind):
    import hashlib
    from test_gwemu_savestate import error
    with backed(tmp_path / 'session', OPT_IN) as n:
        data = encoded(n)
        start_decode(n)
        feed(n, data)
        wait_decode(n)
        fill(n, FB, 0xf800)
        setup_display(n)
        screen(n, tmp_path / 'screen.ppm', b'\xff\0\0')
        prop(n, 'save-state', tmp_path / 'good')
        raw = bytearray((tmp_path / 'good').read_bytes())
        name = ('gnw-h7b0-' + device).encode()
        offset = raw.index(bytes([len(name)]) + name) + 1 + len(name) + 8
        if device == 'jpeg':
            offset += 4096  # registers precede bounded runtime header
            offset += 24 if kind == 'length' else 0
        else:
            # Serialized frame dimensions follow explicit scalar state.
            # Locate the 32x16 frame header and first red pixel inside section.
            marker = struct.pack('>III', 32, 16, 0xffff0000)
            offset = raw.index(marker, offset)
        struct.pack_into('>I', raw, offset, 0xffffffff)
        header = struct.unpack_from('>I', raw, 12)[0]
        raw[header - 32:header] = hashlib.sha256(raw[header:]).digest()
        (tmp_path / 'bad').write_bytes(raw)
        error(n, 'load-state', tmp_path / 'bad', 'state|State|load|Load|Invalid')
        assert not n.command('query-status')['running']
        prop(n, 'load-state', tmp_path / 'good')
        assert any(output_words(n))
        screen(n, tmp_path / 'recovered.ppm', b'\xff\0\0')


def test_ltdc_staged_reload_pixels_settle_without_vbr_or_time_advance(tmp_path):
    from test_gwemu_savestate_runtime import snapshot_virtual_clock
    with backed(tmp_path / 'session', OPT_IN) as n:
        # Large composition keeps the worker occupied while a second reload
        # captures its own immutable RAM. Only the first visible pixel is
        # needed; unmapped remainder reads as zero, just as normal MMIO scanout.
        fill(n, FB, 0xf800, width=1, height=1)
        fill(n, FB2, 0x07e0, width=1, height=1)
        setup_display(n, width=2048, height=1024)
        n.write32(L + 0xac, FB2)
        n.write32(L + 0x24, 1)
        n.write32(L + 0xac, FB)
        n.write32(L + 0x24, 2)
        fill(n, FB2, 0x001f, width=1, height=1)
        n.write32(L + 0x3c, 15)
        prop(n, 'save-state', tmp_path / 'state')
        assert n.read32(L + 0x24) & 2
        assert n.read32(L + 0x38) & 8 == 0
        prop(n, 'save-state', tmp_path / 'again')
        assert snapshot_virtual_clock(tmp_path / 'state') == snapshot_virtual_clock(tmp_path / 'again')
        path = tmp_path / 'settled.ppm'
        n.command('screendump', {'filename': str(path)})
        assert path.read_bytes().split(b'\n', 3)[3][:3] == b'\0\xff\0'
        # Mutate future scanout and then restore the settled staged frame.
        n.write32(L + 0x94, 5)  # structural reload guarantees fresh capture
        n.write32(L + 0x24, 1)
        prop(n, 'load-state', tmp_path / 'state')
        n.command('screendump', {'filename': str(path)})
        assert path.read_bytes().split(b'\n', 3)[3][:3] == b'\0\xff\0'
        assert n.read32(L + 0xac) == FB and n.read32(L + 0x24) & 2


def test_ltdc_layer2_palette_and_fresh_scanout_restore(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        fill(n, FB, 0xf800)
        fill(n, FB2, 2, palette=True)
        setup_display(n)
        screen(n, tmp_path / 'red.ppm', b'\xff\0\0')
        n.write32(L + 0x144, 2 << 24 | 0x00ff00)
        for offset, value in ((0x104, 1), (0x114, 5), (0x118, 255),
                              (0x108, 32 << 16), (0x10c, 16 << 16),
                              (0x12c, FB2), (0x130, 32 << 16 | 35), (0x134, 16)):
            n.write32(L + offset, value)
        n.write32(L + 0x24, 1)
        expected = screen(n, tmp_path / 'green.ppm', b'\0\xff\0')
        prop(n, 'save-state', tmp_path / 'state')
        n.write32(L + 0x144, 2 << 24 | 0x0000ff)
        n.write32(L + 0x118, 254)  # composition change recaptures palette
        n.write32(L + 0x24, 1)
        screen(n, tmp_path / 'blue.ppm', b'\x01\0\xfe')
        prop(n, 'load-state', tmp_path / 'state')
        assert screen(n, tmp_path / 'restored.ppm') == expected
        n.write32(L + 0x12c, FB2 + 32)  # fresh capture uses restored CLUT2
        n.write32(L + 0x24, 1)
        screen(n, tmp_path / 'fresh.ppm', b'\0\xff\0')


def test_ltdc_no_frame_after_reset_retains_saved_paused_surface(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        fill(n, FB, 0xf800)
        setup_display(n)
        expected = screen(n, tmp_path / 'red.ppm', b'\xff\0\0')
        n.command('system_reset')
        prop(n, 'save-state', tmp_path / 'state')
        fill(n, FB, 0x001f)
        setup_display(n)
        screen(n, tmp_path / 'future.ppm', b'\0\0\xff')
        prop(n, 'load-state', tmp_path / 'state')
        assert screen(n, tmp_path / 'restored.ppm') == expected


def test_ltdc_line_irq_retains_remaining_phase(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.write32(L + 0x40, 120)  # halfway through fallback 240-line frame
        n.write32(L + 0x24, 1)  # reload is the model timer recalculation point
        n.write32(L + 0x34, 1)
        n.command('cont')
        n.step(3_000_000)
        n.command('stop')
        n.write32(L + 0x3c, 15)
        n.write32(0xe000e288, 1 << 24)  # clear NVIC LTDC IRQ88 pending
        prop(n, 'save-state', tmp_path / 'state')
        n.write32(L + 0x40, 0)
        n.write32(L + 0x24, 1)
        n.command('cont')
        n.step(20_000_000)
        n.command('stop')
        prop(n, 'load-state', tmp_path / 'state')
        n.command('cont')
        n.step(5_000_000)
        assert n.read32(L + 0x38) & 1 == 0
        assert n.read32(0xe000e208) & (1 << 24) == 0
        n.step(400_000)
        assert n.read32(L + 0x38) & 1
        assert n.read32(0xe000e208) & (1 << 24)
        n.command('stop')
        n.write32(L + 0x3c, 15)
        prop(n, 'save-state', tmp_path / 'completed')
        n.write32(L + 0x40, 0)
        n.write32(L + 0x24, 1)
        prop(n, 'load-state', tmp_path / 'completed')
        n.command('cont')
        n.step(1_000_000)
        assert n.read32(L + 0x38) & 1 == 0
