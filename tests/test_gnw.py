"""End-to-end tests: boot the stock firmware headless and check behaviour."""
import re
import sys
from pathlib import Path

import pytest

from conftest import have_firmware
from harness import GnW
from harness.gnw import FIRMWARE

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import gnwcrypt  # noqa: E402

zelda = pytest.mark.skipif(not have_firmware("zelda"), reason="no Zelda dumps")
mario = pytest.mark.skipif(not have_firmware("mario"), reason="no Mario dumps")


def lit_fraction(img):
    hist = img.convert("L").histogram()
    return sum(hist[17:]) / sum(hist)


def boot(model, ms=3000, **kw):
    gw = GnW(model, deterministic=True, **kw).start()
    gw.run(ms)
    return gw


@pytest.mark.parametrize("model", [
    pytest.param("zelda", marks=zelda), pytest.param("mario", marks=mario)])
def test_otfdec_window_matches_reference(model):
    """The XIP window holds what game-and-watch-patch's crypt() produces."""
    internal = (FIRMWARE / f"internal_flash_backup_{model}.bin").read_bytes()
    external = (FIRMWARE / f"flash_backup_{model}.bin").read_bytes()
    ref = gnwcrypt.crypt(internal, external, model)
    m = gnwcrypt.MODELS[model]
    with boot(model, 1000) as gw:
        for off in (m["start"], (m["start"] + m["end"]) // 2 & ~15, m["end"] - 0x1000):
            assert gw.read_mem(0x90000000 + off, 0x1000) == ref[off:off + 0x1000]


@zelda
def test_save_tags_verified_by_cryp(tmp_path):
    """CRYP's AES-GCM tags equal the tags stored with both NVRAM copies."""
    log = tmp_path / "log.txt"
    with boot("zelda", 3000, log=str(log)):
        pass
    tags = re.findall(r"gnw-cryp: GCM \w+ A=\d+ C=\d+ tag ([0-9a-f]{32})",
                      log.read_text())
    flash = (FIRMWARE / "flash_backup_zelda.bin").read_bytes()
    assert flash[0:16].hex() in tags
    assert flash[0x1000:0x1010].hex() in tags


@zelda
def test_zelda_clock_menu_and_game(golden):
    with boot("zelda") as gw:
        clock = gw.frame()
        assert lit_fraction(clock) > 0.5
        golden("zelda-clock", clock)
        assert gw.pc >> 24 == 0x08                  # in the main loop

        gw.press("game", 150, 1000)
        menu = gw.frame()
        assert menu.tobytes() != clock.tobytes()
        golden("zelda-menu", menu)

        gw.press("a", 150, 3000)                    # The Legend of Zelda
        title = gw.frame()
        assert lit_fraction(title) > 0.5
        golden("zelda-nes-title", title)


@zelda
def test_zelda_links_awakening_runs(golden):
    with boot("zelda") as gw:
        gw.press("game", 150, 1000)
        gw.press("down", 100, 200)
        gw.press("down", 100, 200)
        gw.press("a", 150, 8000)
        frame = gw.frame()
        assert lit_fraction(frame) > 0.3
        golden("zelda-gb-intro", frame)


@zelda
def test_power_button_turns_display_off_and_on():
    with boot("zelda") as gw:
        gw.press("power", 200, 2000)
        assert lit_fraction(gw.frame()) < 0.01
        gw.press("power", 200, 3000)
        assert lit_fraction(gw.frame()) > 0.5


@zelda
def test_deterministic_runs_are_identical():
    frames = []
    for _ in range(2):
        with boot("zelda", 2000) as gw:
            gw.press("game", 120, 777)
            frames.append(gw.read_mem(0x24000000, 0x100000))
    assert frames[0] == frames[1]


@mario
def test_mario_boots_to_clock_and_menu(golden):
    with boot("mario") as gw:
        clock = gw.frame()
        assert lit_fraction(clock) > 0.5
        golden("mario-clock", clock)
        gw.press("game", 150, 1500)
        golden("mario-menu", gw.frame())


@zelda
def test_saves_go_to_overlay_only(tmp_path):
    overlay = tmp_path / "zelda_overlay.bin"
    original = (FIRMWARE / "flash_backup_zelda.bin").read_bytes()
    with boot("zelda", 2000, overlay=str(overlay)):
        pass
    assert overlay.exists() and overlay.stat().st_size == len(original)
    assert (FIRMWARE / "flash_backup_zelda.bin").read_bytes() == original
