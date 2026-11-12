"""Optional local-ROM power acceptance; every mounted image is a fresh copy."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

import pytest

from test_gwemu_desktop import ROOT, Native
from test_gwemu_power import convert, property, GPIOA, GPIOE

pytestmark = pytest.mark.skipif(
    os.environ.get("GNW_FIRMWARE_POWER_TEST") != "1",
    reason="opt in to local firmware and SD copy acceptance",
)
PROFILES = {
    "mario": "profiles/mario.gnw.json",
    "zelda": "profiles/zelda.gnw.json",
    "flash-retrogo": "out/profiles/backup-full_20261104_1021.gnw.json",
    "sd-retrogo": "out/profiles/sd-full_20261104_1021-spi1.gnw.json",
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


@pytest.mark.parametrize("name", PROFILES)
def test_real_firmware_power_inputs_on_isolated_copies(tmp_path, name):
    profile_path = ROOT / PROFILES[name]
    if not profile_path.exists():
        pytest.skip("local profile absent")
    profile = json.loads(profile_path.read_text())
    sources = {key: (profile_path.parent / profile[key]).resolve()
               for key in ("internalFlash", "externalFlash", "bank2Flash", "sdCard")
               if key in profile}
    if not all(path.exists() for path in sources.values()):
        pytest.skip("local firmware or SD absent")
    before = {key: digest(path) for key, path in sources.items()}
    names = {"internalFlash": "bank1.bin", "externalFlash": "flash.bin",
             "bank2Flash": "bank2.bin", "sdCard": "sdcard.img"}
    for key, source in sources.items():
        shutil.copyfile(source, tmp_path / names[key])
    globals = []
    if "bank2Flash" in sources:
        globals.append(f"gnw-h7b0-soc.bank2-image={tmp_path / 'bank2.bin'}")
    if name in ("mario", "zelda"):
        globals.append("gnw-h7b0-soc.uid=310047000b51333138343134")
    machine = Native(tmp_path, ",power-model=on,battery=80,usb-power=on,"
                     "battery-life-min=0,charge-time-min=0", globals=globals)
    # Execute firmware on TCG; QTest remains only a test MMIO observer.
    index = machine.args.index("-accel")
    del machine.args[index:index + 2]
    chip = {1: "c2-25-34", 4: "c2-25-36", 64: "c2-25-3a"}[
        sources["externalFlash"].stat().st_size // (1024 * 1024)]
    index = machine.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
    machine.args[index] = "gnw-h7b0-soc.extflash-chip=" + chip
    if "sdCard" in sources:
        machine.args += ["-drive", f"if=sd,format=raw,file={tmp_path / 'sdcard.img'}"]
    evidence = ROOT / "out/gwemu-power-controls/firmware" / name
    evidence.mkdir(parents=True, exist_ok=True)
    screen = evidence / "screen.ppm"
    try:
        with machine:
            started = time.monotonic()
            machine.command("cont")
            if "retrogo" in name:
                time.sleep(.5)
                for down in (True, False):
                    machine.command("input-send-event", {"events": [
                        {"type": "key", "data": {"down": down,
                         "key": {"type": "qcode", "data": key}}}
                        for key in ("left", "g")]})
                    if down:
                        time.sleep(.3)
            # Capture after the initial OFW intro and startup handoff interval.
            time.sleep(max(0, 3 - (time.monotonic() - started)))
            deadline = time.monotonic() + 20
            while True:
                machine.command("screendump", {"filename": str(screen)})
                magic, geometry, maximum, pixels = screen.read_bytes().split(b"\n", 3)
                assert (magic, geometry, maximum) == (b"P6", b"640 480", b"255")
                lit = sum(r + g + b > 30 for r, g, b in
                          zip(pixels[::3], pixels[1::3], pixels[2::3]))
                if lit > 20000:
                    break
                assert time.monotonic() < deadline, "firmware did not render"
                time.sleep(.1)
            machine.command("stop")
            vtor = machine.read32(0xe000ed08)
            if "retrogo" in name:
                assert vtor == 0x08100000, "Retro-Go bank2 handoff did not occur"
            initial = [convert(machine), machine.read32(GPIOA), machine.read32(GPIOE)]
            assert initial[0] == 12600
            assert initial[1] & 4 == 0 and initial[2] & 128 == 0
            property(machine, "usb-power", False)
            property(machine, "battery", 30)
            changed = [convert(machine, 1), machine.read32(GPIOA), machine.read32(GPIOE)]
            assert changed[0] == 11600
            assert changed[1] & 4 and changed[2] & 128
            (evidence / "power.json").write_text(json.dumps({
                "profile": name, "litPixels": lit, "before": initial,
                "vtor": vtor, "observationSeconds": time.monotonic() - started,
                "after": changed, "sourceHashes": before,
                "scope": "rendered firmware and MMIO inputs; no supply-domain acceptance",
            }, indent=2) + "\n")
    finally:
        assert {key: digest(path) for key, path in sources.items()} == before
