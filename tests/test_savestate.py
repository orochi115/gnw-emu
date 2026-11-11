"""State replay exercises the whole VM and session flash, not just RAM copies."""
import hashlib

import pytest

from harness.gnw import GnW


def action(gw, name, path):
    return gw.qmp.cmd("qom-set", path="/machine", property=name, value=str(path))


def signature(gw):
    return (gw.pc, hashlib.sha256(gw.read_mem(0x20000000, 128 * 1024)).hexdigest(),
            hashlib.sha256(gw.read_mem(0x24000000, 1024 * 1024)).hexdigest(),
            hashlib.sha256(gw.frame().tobytes()).hexdigest(),
            gw.read_mem(0x52005000, 0x50) + gw.read_mem(0x52005054, 0xcc), gw.read_mem(0x50001000, 0x100))


def game_signature(gw):
    # IRQ scheduling around a snapshot can change idle PC/stack bytes.
    # Compare game data and the rendered result after advancing time.
    return (gw.read_mem(0x20000000, 64 * 1024),
            gw.read_mem(0x24000000, 1024 * 1024), gw.frame().tobytes())


@pytest.mark.parametrize("model", ["mario", "zelda"])
def test_state_replays_in_same_and_new_process(model, tmp_path):
    state = tmp_path / "state.bin"
    with GnW(model, deterministic=True) as gw:
        gw.run(1500)
        saved = signature(gw)
        action(gw, "save-state", state)
        gw.run(180)
        future = game_signature(gw)
        for _ in range(2):
            action(gw, "load-state", state)
            assert signature(gw) == saved
            gw.run(180)
            assert game_signature(gw) == future
    with GnW(model, deterministic=True) as gw:
        action(gw, "load-state", state)
        assert signature(gw) == saved
        gw.run(180)
        assert game_signature(gw) == future


def test_flash_restore_updates_raw_commands_xip_and_session_files(tmp_path):
    external = tmp_path / "flash.bin"
    bank1 = tmp_path / "bank1.bin"
    state = tmp_path / "state.bin"
    with GnW("zelda", deterministic=True, overlay=str(external),
             bank1_overlay=str(bank1)) as gw:
        gw.run(300)
        ext_before = external.read_bytes()
        int_before = bank1.read_bytes()
        action(gw, "save-state", state)
        gw.run(500)
        action(gw, "load-state", state)
        assert external.read_bytes() == ext_before
        assert bank1.read_bytes() == int_before
        assert gw.read_mem(0x08000000, len(int_before)) == int_before


def test_sd_and_oversize_are_refused_without_state_file(tmp_path):
    card = tmp_path / "card.img"
    with card.open("wb") as f:
        f.truncate(512 * 1024)
    with GnW("zelda", sdcard=str(card)) as gw:
        assert gw.qmp.cmd("qom-get", path="/machine", property="savestate-support") == "sd"
        with pytest.raises(Exception, match="SD"):
            action(gw, "save-state", tmp_path / "denied.bin")
    assert not (tmp_path / "denied.bin").exists()


def test_inflight_hash_and_flash_programming_are_restored(tmp_path):
    from test_backlight import MMIO
    import struct
    internal = tmp_path / "internal.bin"
    external = tmp_path / "external.bin"
    internal.write_bytes(struct.pack("<II", 0x20010000, 0x08000009) + b"\xfe\xe7")
    external.write_bytes(b"\xff" * 4096)
    bank = tmp_path / "bank.bin"
    flash = tmp_path / "flash.bin"
    state = tmp_path / "state.bin"
    gw = GnW(internal=str(internal), external=str(external),
             bank1_overlay=str(bank), overlay=str(flash))
    socket = gw.tmp / "qtest.sock"
    gw.args += ["-qtest", f"unix:{socket},server=on,wait=off", "-qtest-log", "/dev/null"]
    with gw:
        io = MMIO(gw, socket)
        try:
            HASH = 0x48021400
            io.write(HASH, 4)  # SHA1 INIT
            io.write(HASH + 4, 0x11223344)
            action(gw, "save-state", state)
            def digest():
                io.write(HASH + 4, 0x55667788)
                io.write(HASH + 8, 0x100)
                return gw.read_mem(HASH + 0xc, 20)
            expected = digest()
            # Program one 128-bit internal flash word via the guest interface.
            FLASH = 0x52002000
            io.write(FLASH + 4, 0x45670123)
            io.write(FLASH + 4, 0xcdef89ab)
            io.write(FLASH + 0xc, 2)
            for offset in range(0, 16, 4):
                io.write(0x08000100 + offset, 0)
            assert bank.read_bytes()[0x100:0x110] == bytes(16)
            # OSPI WREN then a four-byte page program, with a partial data phase.
            OSPI = 0x52005000
            io.write(OSPI, 1)
            io.write(OSPI + 0x100, 1)
            io.write(OSPI + 0x110, 6)
            io.write(OSPI + 0x40, 3)
            io.write(OSPI + 0x100, 1 | (1 << 8) | (2 << 12) | (1 << 24))
            io.write(OSPI + 0x110, 2)
            io.write(OSPI + 0x48, 0x100)
            io.write(OSPI + 0x50, 0)
            assert flash.read_bytes()[0x100:0x104] == bytes(4)
            action(gw, "load-state", state)
            assert bank.read_bytes()[0x100:0x110] == b"\xff" * 16
            assert flash.read_bytes()[0x100:0x104] == b"\xff" * 4
            assert digest() == expected
        finally:
            io.close()


@pytest.mark.parametrize("wiring", ["spi1", "ospi"])
def test_load_also_refuses_sd_regardless_of_wiring(wiring, tmp_path):
    card = tmp_path / "card.img"
    card.write_bytes(bytes(512 * 1024))
    with GnW(sdcard=str(card), sd_wiring=wiring) as gw:
        with pytest.raises(Exception, match="SD"):
            action(gw, "load-state", tmp_path / "missing.bin")


def test_large_flash_rejected_and_corrupt_load_can_be_rolled_back(tmp_path):
    large = tmp_path / "large.bin"
    with large.open("wb") as f:
        f.truncate(128 * 1024 * 1024)
    with GnW(external=str(large)) as gw:
        assert gw.qmp.cmd("qom-get", path="/machine", property="savestate-support") == "flash-size"
        with pytest.raises(Exception, match="64 MiB"):
            action(gw, "save-state", tmp_path / "denied.bin")
    assert not (tmp_path / "denied.bin").exists()
    good = tmp_path / "good.bin"
    broken = tmp_path / "broken.bin"
    with GnW(deterministic=True) as gw:
        gw.run(1500)
        expected = signature(gw)
        action(gw, "save-state", good)
        broken.write_bytes(good.read_bytes()[:good.stat().st_size // 2])
        gw.run(100)
        with pytest.raises(Exception):
            action(gw, "load-state", broken)
        assert not gw.qmp.cmd("query-status")["running"]
        action(gw, "load-state", good)
        assert signature(gw) == expected
        gw.run(100)


def test_display_geometry_and_partial_ospi_write_restore(tmp_path):
    from test_backlight import MMIO, configure_panel, LTDC
    import struct
    internal = tmp_path / "internal.bin"
    external = tmp_path / "external.bin"
    internal.write_bytes(struct.pack("<II", 0x20010000, 0x08000009) + b"\xfe\xe7")
    external.write_bytes(b"\xff" * 4096)
    gw = GnW(internal=str(internal), external=str(external))
    socket = gw.tmp / "qtest.sock"
    gw.args += ["-qtest", f"unix:{socket},server=on,wait=off", "-qtest-log", "/dev/null"]
    with gw:
        io = MMIO(gw, socket)
        try:
            configure_panel(io)
            assert gw.frame().size == (2, 2)
            OSPI = 0x52005000
            io.write(OSPI, 1)
            io.write(OSPI + 0x100, 1)
            io.write(OSPI + 0x110, 6)
            io.write(OSPI + 0x40, 3)
            io.write(OSPI + 0x100, 1 | (1 << 8) | (2 << 12) | (1 << 24))
            io.write(OSPI + 0x110, 2)
            io.write(OSPI + 0x48, 0x100)
            io.write(OSPI + 0x50, 0x11, "b")
            action(gw, "save-state", tmp_path / "partial.bin")
            io.write(OSPI + 0x50, 0x22, "b")
            io.write(OSPI + 0x50, 0x33, "b")
            io.write(OSPI + 0x50, 0x44, "b")
            io.write(LTDC + 0x10, (10 << 16) | 10)
            io.write(LTDC + 0x24, 1)
            assert gw.frame().size == (10, 10)
            action(gw, "load-state", tmp_path / "partial.bin")
            assert gw.frame().size == (2, 2)
            io.write(OSPI + 0x50, 0xaa, "b")
            io.write(OSPI + 0x50, 0xbb, "b")
            io.write(OSPI + 0x50, 0xcc, "b")
            assert gw.read_mem(0x90000100, 4) == bytes.fromhex("11aabbcc")
        finally:
            io.close()


def test_retrogo_64mib_state_roundtrip(tmp_path):
    from test_retrogo import BACKUP
    if not BACKUP or not all((BACKUP / f).exists() for f in ("bank1.bin", "bank2.bin", "ext.bin")):
        pytest.skip("no full Retro-Go backup")
    if (BACKUP / "ext.bin").stat().st_size > 64 * 1024 * 1024:
        pytest.skip("backup exceeds supported flash size")
    with GnW(deterministic=True, internal=str(BACKUP / "bank1.bin"),
             bank2=str(BACKUP / "bank2.bin"), external=str(BACKUP / "ext.bin"),
             overlay=str(tmp_path / "flash.bin"),
             bank1_overlay=str(tmp_path / "bank1.bin"),
             bank2_overlay=str(tmp_path / "bank2.bin")) as gw:
        gw.run(2500)
        gw.press("left+game", 300, 3000)
        assert gw.hmp("x /1wx 0xE000ED08").split()[-1] == "0x08100000"
        state = tmp_path / "retrogo.bin"
        expected = signature(gw)
        action(gw, "save-state", state)
        gw.press("b", 100, 300)
        action(gw, "load-state", state)
        assert signature(gw) == expected
        gw.run(300)
        assert gw.frame().size == (320, 240)
        action(gw, "load-state", state)
        assert signature(gw) == expected


def test_realtime_restore_resumes_pacing_without_fast_forward(tmp_path):
    import time
    with GnW(realtime=True) as gw:
        gw.run(200)
        state = tmp_path / "paced.bin"
        action(gw, "save-state", state)
        gw.run(800)
        action(gw, "load-state", state)
        start = time.monotonic()
        gw.run(200)
        assert time.monotonic() - start >= 0.12
