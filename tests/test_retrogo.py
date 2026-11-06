"""Dual-boot backup: patched stock firmware in bank 1, Retro-Go in bank 2.

Needs a full device backup (bank1.bin, bank2.bin, ext.bin as written by
game-and-watch-backup's gnw_full_backup.py).  Point GNW_FULL_BACKUP at the
directory; by default the newest ../game-and-watch-backup/backups/full_*
is used.  Skipped when none is found.  Nothing about the backup's contents
is stored in the repository.
"""
import os
from pathlib import Path

import pytest

from harness import GnW


def find_backup():
    env = os.environ.get("GNW_FULL_BACKUP")
    if env:
        return Path(env)
    root = Path(__file__).resolve().parents[2] / "game-and-watch-backup" / "backups"
    dirs = sorted(root.glob("full_*")) if root.exists() else []
    return dirs[-1] if dirs else None


BACKUP = find_backup()
needs_backup = pytest.mark.skipif(
    not (BACKUP and all((BACKUP / f).exists() for f in ("bank1.bin", "bank2.bin", "ext.bin"))),
    reason="no full device backup (set GNW_FULL_BACKUP)")


def green_header(img, brightness):
    """Fraction of the top 30 rows in Retro-Go's green title-bar colour."""
    im = img.convert("RGB")
    px = [im.getpixel((x, y)) for y in range(30) for x in range(im.width)]
    return sum(1 for r, g, b in px
               if g * 4095 > 90 * brightness and
               (g - r) * 4095 > 30 * brightness and
               (g - b) * 4095 > 30 * brightness) / len(px)


@needs_backup
def test_retrogo_brightness_menu(tmp_path, check_brightness_menu):
    with GnW("zelda", deterministic=True, internal=str(BACKUP / "bank1.bin"),
             external=str(BACKUP / "ext.bin"), bank2=str(BACKUP / "bank2.bin"),
             overlay=str(tmp_path / "ov.bin")) as gw:
        gw.run(3000)
        gw.press("left+game", 300, 4000)
        gw.press("b", 400, 2000)
        gw.press("pause", 400, 1500)
        for _ in range(5):
            gw.press("down", 300, 400)
        gw.press("a", 400, 8000)  # quit resumed game to the launcher
        gw.press("pause", 300, 700)  # settings starts on brightness
        check_brightness_menu(gw, (90, 140, 230, 195))


@needs_backup
def test_left_game_boots_retrogo_and_cover_flow(tmp_path):
    with GnW("zelda", deterministic=True, internal=str(BACKUP / "bank1.bin"),
             external=str(BACKUP / "ext.bin"), bank2=str(BACKUP / "bank2.bin"),
             overlay=str(tmp_path / "ov.bin")) as gw:
        gw.run(3000)
        gw.press("left+game", 300, 4000)
        # The patched bootloader jumped to bank 2: Retro-Go sets VTOR there.
        # (SCB is CPU-private, so read it through the CPU, not pmemsave.)
        assert gw.hmp("x /1wx 0xE000ED08").split()[-1] == "0x08100000"
        # Retro-Go resumes the last game; leave it via PAUSE -> last menu entry.
        gw.press("b", 400, 2000)
        gw.press("pause", 400, 1500)
        for _ in range(5):
            gw.press("down", 300, 400)
        gw.press("a", 400, 8000)
        # Main menu with cover flow (JPEG codec + DMA2D YCbCr input).
        brightness = int(gw.hmp("xp /1wx 0x4000742c").split()[-1], 16)
        assert brightness > 0
        assert green_header(gw.frame(), brightness) > 0.5


@needs_backup
def test_realtime_mode_keeps_systick_and_pace(tmp_path):
    """realtime=True: no SysTick interrupts lost, and guest time ~ wall time.

    Without icount, late main-loop timers made the NVIC merge SysTick
    expiries; Retro-Go's HAL_GetTick() then ran ~1/3 slow and its frame
    pacing skipped audio half-buffers.
    """
    import time

    def uwtick(gw):
        # HAL uwTick of this Retro-Go build (from gw_retro_go.map).
        return int(gw.hmp("x /1wx 0x2000ec6c").split()[-1], 16)

    with GnW("zelda", realtime=True, internal=str(BACKUP / "bank1.bin"),
             external=str(BACKUP / "ext.bin"), bank2=str(BACKUP / "bank2.bin"),
             overlay=str(tmp_path / "ov.bin")) as gw:
        gw.run(2000)
        gw.press("left+game", 300, 3000)
        t0, v0, w0 = uwtick(gw), gw.vtime_ms, time.time()
        gw.run(3000)
        t1, v1, w1 = uwtick(gw), gw.vtime_ms, time.time()
    assert abs((t1 - t0) - (v1 - v0)) <= 0.01 * (v1 - v0)
    assert 2.7 < w1 - w0 < 4.0


@needs_backup
def test_cover_flow_redraw_does_not_flicker(tmp_path):
    """The idle cover flow redraws every ~0.3 s into the back buffer only.

    LTDC used to raise RRIF on immediate reloads; the stale flag fired as
    soon as lcd_swap() enabled RRIE, and the screen showed the buffer that
    was being redrawn.
    """
    with GnW("zelda", deterministic=True, internal=str(BACKUP / "bank1.bin"),
             external=str(BACKUP / "ext.bin"), bank2=str(BACKUP / "bank2.bin"),
             overlay=str(tmp_path / "ov.bin")) as gw:
        gw.run(3000)
        gw.press("left+game", 300, 4000)
        gw.press("b", 400, 1500)
        gw.press("pause", 400, 1000)
        for _ in range(5):
            gw.press("down", 300, 300)
        gw.press("a", 400, 4000)
        first = gw.frame().convert("L").tobytes()
        for _ in range(100):
            gw.run(10)
            cur = gw.frame().convert("L").tobytes()
            assert sum(1 for a, b in zip(first, cur) if abs(a - b) > 30) < 200
