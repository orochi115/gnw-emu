"""End-to-end tests: boot the stock firmware headless and check behaviour."""
import re
import struct
import sys
import wave
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
def test_zelda_audio_has_no_buffer_seam(tmp_path):
    # SAI1 runs from pll2_p at ~48 kHz. At the wrong rate the game's buffer
    # queue overruns and every 240-sample block ends with a click.
    wav = tmp_path / "a.wav"
    with boot("zelda", wav=str(wav)) as gw:
        gw.press("game", 150, 1000)
        gw.press("a", 150, 6000)
    with wave.open(str(wav)) as w:
        assert 47900 < w.getframerate() < 48100
        d = struct.unpack(f"<{w.getnframes()}h", w.readframes(w.getnframes()))
    jump = [abs(d[i + 1] - 2 * d[i] + d[i - 1]) for i in range(1, len(d) - 1)]
    thr = sorted(jump)[len(jump) * 995 // 1000]
    at = [0] * 240
    for i, v in enumerate(jump):
        if v > thr:
            at[(i + 1) % 240] += 1
    assert sum(at) > 100                        # the music is playing
    assert at[238] + at[239] < 6 * sum(at) / 240


@zelda
def test_power_button_turns_display_off_and_on():
    with boot("zelda") as gw:
        brightness = int(gw.hmp("xp /1wx 0x4000742c").split()[-1], 16)
        gw.press("power", 200, 2000)
        assert lit_fraction(gw.frame()) < 0.01
        gw.press("power", 200, 3000)
        assert lit_fraction(gw.frame()) > 0.5
        assert int(gw.hmp("xp /1wx 0x4000742c").split()[-1], 16) == brightness


@pytest.mark.parametrize("model", [
    pytest.param("zelda", marks=zelda), pytest.param("mario", marks=mario)])
def test_stock_brightness_menu(model, check_brightness_menu):
    with boot(model) as gw:
        gw.press("game", 150, 400)
        gw.press("pause", 150, 400)
        gw.press("down", 150, 400)  # volume -> brightness
        # SET TIME is unchanged as the slider moves, so its intensity
        # measures backlight rather than a change in the menu's contents.
        check_brightness_menu(gw, (80, 154, 240, 174))


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


def icon_colours(img, brightness):
    """Green / red pixel counts in the stock menu's battery icon."""
    raw = img.convert("RGB").crop((276, 0, 312, 16)).tobytes()
    px = [tuple(raw[i:i + 3]) for i in range(0, len(raw), 3)]
    # Preserve the original colour thresholds in unscaled RGB units.
    green = sum(1 for r, g, b in px
                if g * 4095 > 150 * brightness and r * 4095 < 100 * brightness)
    red = sum(1 for r, g, b in px
              if r * 4095 > 150 * brightness and g * 4095 < 100 * brightness)
    return green, red


@zelda
@pytest.mark.parametrize("percent, raw, expect", [
    (100, None, "green"), (20, None, "red"),
    # Below the stock cutoff (10661 on the Zelda board), under Retro-Go's 0 %.
    (0, 10500, "off")])
def test_zelda_battery_level(percent, raw, expect):
    """ADC2 channel 4 follows battery=; the stock firmware powers off when empty.

    Same scale as Retro-Go (a device near full reads ~13000 in both).
    """
    with boot("zelda", battery=percent, adc_override=raw) as gw:
        gw.press("game", 150, 1000)
        menu = gw.frame()
        brightness = int(gw.hmp("xp /1wx 0x4000742c").split()[-1], 16)
    if expect == "off":
        assert lit_fraction(menu) < 0.05
        return
    green, red = icon_colours(menu, brightness)
    assert (green > 20 and red == 0) if expect == "green" else (red > 8 and green == 0)


@zelda
def test_battery_drain_charge_and_runtime_set():
    with boot("zelda", 1000, battery_life_min=1, charge_time_min=2) as gw:
        gw.set_battery(100)
        gw.run(30000)                       # 1 min for 100 % -> 50 %
        assert abs(gw.battery - 50) <= 1
        gw.set_usb(True)
        gw.run(30000)                       # 2 min for 100 % -> +25 %
        assert abs(gw.battery - 75) <= 1
        gw.set_battery(10)
        assert gw.battery == 10
