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


def green_header(img):
    """Fraction of the top 30 rows in Retro-Go's green title-bar colour."""
    im = img.convert("RGB")
    px = [im.getpixel((x, y)) for y in range(30) for x in range(im.width)]
    return sum(1 for r, g, b in px if g > 90 and g > r + 30 and g > b + 30) / len(px)


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
        assert green_header(gw.frame()) > 0.5
