"""Retro-Go SD (microSD card mod) end to end.

Needs, and skips without:
  * a Retro-Go SD build: ../retro-go-sd (or GNW_RETROGO_SD), built with
    scripts/build_retrogo_sd.sh (bank 2, Zelda)
  * cores and the SD bootloader in out/dl (scripts/fetch_cores.sh)
  * mtools, and arm-none-eabi-nm (PATH, GCC_PATH or the 10.3 toolchain)
  * ROMs: ../xx/game-and-watch-retro-go/roms (or GNW_SD_ROMS)
The dual-boot update test also needs out/sd/dualboot/{bank1,ext}.bin from
scripts/make_sd_dualboot.py.

Bank 1 holds sylverb's standalone SD bootloader, which starts Retro-Go in
bank 2 (or installs it from retro-go_update.bin first), so no device backup
is needed.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from harness import GnW

ROOT = Path(__file__).resolve().parents[1]
RG = Path(os.environ.get("GNW_RETROGO_SD", ROOT.parent / "retro-go-sd"))
ROMS = Path(os.environ.get("GNW_SD_ROMS",
                           ROOT.parent / "xx" / "game-and-watch-retro-go" / "roms"))
DL = ROOT / "out" / "dl"
BOOTLOADER = DL / "bootloader" / "gnw_bootloader.bin"
INTFLASH = RG / "build" / "gw_retro_go_intflash.bin"
ELF = RG / "build" / "gw_retro_go.elf"
DUALBOOT = ROOT / "out" / "sd" / "dualboot"

SDCARD_HW_SPI1, SDCARD_HW_OSPI1 = 2, 3


def find_nm():
    for d in filter(None, [os.environ.get("GCC_PATH"),
                           "/opt/gcc-arm-none-eabi-10.3-2021.10/bin"]):
        p = Path(d) / "arm-none-eabi-nm"
        if p.exists():
            return str(p)
    return shutil.which("arm-none-eabi-nm")


NM = find_nm()
needs_sd = pytest.mark.skipif(
    not (INTFLASH.exists() and ELF.exists() and BOOTLOADER.exists() and
         (DL / "fceumm" / "x").exists() and ROMS.exists() and NM and
         shutil.which("mformat")),
    reason="Retro-Go SD build, cores, ROMs, mtools or nm missing")


def symbols():
    out = subprocess.run([NM, str(ELF)], capture_output=True, text=True,
                         check=True).stdout
    return {l.split()[2]: int(l.split()[0], 16)
            for l in out.splitlines() if len(l.split()) == 3}


@pytest.fixture(scope="module")
def card(tmp_path_factory):
    """Small card: NES + Genesis ROMs, all cores, plus the update file."""
    d = tmp_path_factory.mktemp("sd")
    img = d / "card.img"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_sd_image.py"),
                    str(img), "--retrogo", str(RG), "--roms", str(ROMS),
                    "--systems", "nes,md", "--size-mb", "256"],
                   check=True, capture_output=True)
    upd = d / "card_update.img"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_sd_image.py"),
                    str(upd), "--retrogo", str(RG), "--roms", str(ROMS),
                    "--systems", "nes", "--size-mb", "256", "--with-update"],
                   check=True, capture_output=True)
    ext = d / "ext64m.bin"
    with open(ext, "wb") as f:
        f.truncate(64 * 1024 * 1024)
    return {"img": img, "update": upd, "ext": ext, "syms": symbols()}


def boot(card, tmp_path, img=None, **kw):
    if "bank2_overlay" not in kw:
        kw["bank2"] = str(INTFLASH)
    return GnW("zelda", deterministic=True, internal=str(BOOTLOADER),
               external=str(card["ext"]), overlay=str(tmp_path / "ext.bin"),
               sdcard=str(img or card["img"]), sd_snapshot=img is None, **kw)


def word(gw, addr):
    return int(gw.hmp(f"xp /1wx {addr:#x}").split()[-1], 16)


def log(gw, card):
    buf = gw.read_mem(card["syms"]["logbuf"], 4096)
    return buf.split(b"\0")[0].decode("latin1")


def vtor(gw):
    return gw.hmp("x /1wx 0xE000ED08").split()[-1]


def mounted(gw, card):
    s = card["syms"]
    return gw.read_mem(s["fs_mounted"], 1)[0], word(gw, s["sdcard_hw_type"])


@needs_sd
@pytest.mark.parametrize("wiring,hw", [("spi1", SDCARD_HW_SPI1),
                                       ("ospi", SDCARD_HW_OSPI1)])
def test_mount_and_play_nes(card, tmp_path, wiring, hw):
    with boot(card, tmp_path, sd_wiring=wiring) as gw:
        gw.run(6000)
        assert vtor(gw) == "0x08100000"
        assert mounted(gw, card) == (1, hw)
        text = log(gw, card)
        assert "registered 'Nintendo Entertainment System'" in text
        # First NES game: open its menu, "New game".
        gw.press("a", 300, 1500)
        gw.press("a", 300, 6000)
        a = gw.frame().tobytes()
        assert gw.pc >> 20 != 0x081         # in the core (RAM/ITCM), not the launcher
        gw.press("game", 300, 3000)
        assert gw.frame().tobytes() != a


@needs_sd
def test_genesis_flash_cache_and_savestate(card, tmp_path):
    img = tmp_path / "card.img"
    shutil.copy(card["img"], img)
    with boot(card, tmp_path, img=img) as gw:
        gw.run(6000)
        gw.press("down", 300, 1500)         # NES -> Genesis tab
        gw.press("a", 300, 1500)
        gw.press("a", 300, 15000)           # cache the ROM in QSPI, run it
        assert "Region:" in log(gw, card)
        gw.press("pause", 400, 1500)
        gw.press("a", 300, 1500)            # Save & Continue
        gw.press("a", 300, 8000)            # slot 0
        assert "Saving state to" in log(gw, card)
    out = subprocess.run(["mdir", "-i", f"{img}@@1M", "::/data/md"],
                         capture_output=True, text=True, check=True).stdout
    assert ".md-0.sav" in out


@needs_sd
def test_update_from_sd_standalone_bootloader(card, tmp_path):
    img = tmp_path / "card.img"
    shutil.copy(card["update"], img)
    b2 = tmp_path / "bank2.bin"
    with boot(card, tmp_path, img=img, bank1_overlay=str(tmp_path / "b1.bin"),
              bank2_overlay=str(b2)) as gw:
        gw.run(15000)
        assert vtor(gw) == "0x24000000"     # firmware_update, from RAM
        gw.press("a", 300, 8000)            # "Press any button to reboot"
        assert vtor(gw) == "0x08100000"
    fw = INTFLASH.read_bytes()
    assert b2.read_bytes()[:len(fw)] == fw
    out = subprocess.run(["mdir", "-i", f"{img}@@1M", "::"],
                         capture_output=True, text=True, check=True).stdout
    assert "retro-go_update.bin" not in out


@needs_sd
@pytest.mark.skipif(not (DUALBOOT / "bank1.bin").exists(),
                    reason="no dual-boot images (scripts/make_sd_dualboot.py)")
def test_update_from_sd_dual_boot(card, tmp_path):
    img = tmp_path / "card.img"
    shutil.copy(card["update"], img)
    b1, b2 = tmp_path / "b1.bin", tmp_path / "b2.bin"
    with GnW("zelda", deterministic=True, internal=str(DUALBOOT / "bank1.bin"),
             external=str(DUALBOOT / "ext.bin"), overlay=str(tmp_path / "ext.bin"),
             bank1_overlay=str(b1), bank2_overlay=str(b2), sdcard=str(img)) as gw:
        gw.run(3000)
        assert vtor(gw) == "0x08000000"     # stock clock
        gw.press("left+game", 300, 15000)   # -> bootloader -> firmware_update
        assert vtor(gw) == "0x24000000"
        gw.press("a", 300, 4000)            # reboot into the stock firmware
        assert vtor(gw) == "0x08000000"
        gw.press("left+game", 300, 8000)    # -> bootloader -> Retro-Go
        assert vtor(gw) == "0x08100000"
    fw = INTFLASH.read_bytes()
    assert b2.read_bytes()[:len(fw)] == fw
    # With the stock firmware present the bootloader itself is not touched.
    assert b1.read_bytes() == (DUALBOOT / "bank1.bin").read_bytes()
