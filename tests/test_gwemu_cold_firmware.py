"""Opt-in native repeated cold-start acceptance using isolated firmware copies."""
import json
import os
import shutil
import time

import pytest

from test_gwemu_desktop import ROOT, Native
from test_gwemu_power import cold_cycle, property
from test_gwemu_power_firmware import PROFILES, digest

pytestmark = pytest.mark.skipif(
    os.environ.get("GNW_FIRMWARE_COLD_TEST") != "1" and
    os.environ.get("GNW_FIRMWARE_SUPPLY_TEST") != "1",
    reason="opt in to copied local firmware cold-start acceptance",
)
LTDC_GCR = 0x50001018


def keys(machine, down):
    machine.command("input-send-event", {"events": [
        {"type": "key", "data": {"down": down,
         "key": {"type": "qcode", "data": key}}}
        for key in ("left", "g")]})


def wait_for_firmware(machine, screen, retrogo, after_cold=False):
    started = time.monotonic()
    if retrogo:
        # Hold long enough for the SD loader and its guest-time key polling.
        time.sleep(3 if after_cold else 1)
        if after_cold:
            # Cleared backup state presents OFW's PRESS TIME screen first.
            for down in (True, False):
                machine.command("input-send-event", {"events": [
                    {"type": "key", "data": {"down": down,
                     "key": {"type": "qcode", "data": "t"}}}]})
                time.sleep(.5)
        keys(machine, True)
        time.sleep(1)
        keys(machine, False)
    deadline = started + 30
    time.sleep(max(0, 3 - (time.monotonic() - started)))
    while True:
        machine.command("stop")
        enabled = machine.read32(LTDC_GCR) & 1
        vtor = machine.read32(0xe000ed08)
        machine.command("screendump", {"filename": str(screen)})
        magic, geometry, maximum, pixels = screen.read_bytes().split(b"\n", 3)
        assert (magic, geometry, maximum) == (b"P6", b"640 480", b"255")
        lit = sum(r + g + b > 30 for r, g, b in
                  zip(pixels[::3], pixels[1::3], pixels[2::3]))
        if enabled and lit > 20000 and (not retrogo or vtor == 0x08100000):
            return {"litPixels": lit, "vtor": vtor,
                    "ltdcEnabled": bool(enabled),
                    "seconds": time.monotonic() - started}
        assert time.monotonic() < deadline, "no fresh firmware display / bank2 handoff"
        machine.command("cont")
        time.sleep(.1)


@pytest.mark.parametrize("name", PROFILES)
@pytest.mark.parametrize("mode", [
    pytest.param("cold", marks=pytest.mark.skipif(
        os.environ.get("GNW_FIRMWARE_COLD_TEST") != "1", reason="cold test opt-in")),
    pytest.param("supply", marks=pytest.mark.skipif(
        os.environ.get("GNW_FIRMWARE_SUPPLY_TEST") != "1", reason="supply test opt-in")),
])
def test_repeated_cold_start_after_firmware_execution(tmp_path, name, mode):
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
    globals = ["gnw-h7b0-rtc.initial-epoch=1735689600"]
    if "bank2Flash" in sources:
        globals.append(f"gnw-h7b0-soc.bank2-image={tmp_path / 'bank2.bin'}")
    if profile.get("deviceUid"):
        globals.append(f"gnw-h7b0-soc.uid={profile['deviceUid']}")
    machine = Native(tmp_path, ",power-model=on,battery=80,usb-power=on,"
                     "battery-life-min=0,charge-time-min=0", globals=globals)
    index = machine.args.index("-accel")
    del machine.args[index:index + 2]
    chip = {1: "c2-25-34", 4: "c2-25-36", 64: "c2-25-3a"}[
        sources["externalFlash"].stat().st_size // (1024 * 1024)]
    index = machine.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
    machine.args[index] = "gnw-h7b0-soc.extflash-chip=" + chip
    if "sdCard" in sources:
        machine.args += ["-drive", f"if=sd,format=raw,file={tmp_path / 'sdcard.img'}"]
    batch = "gwemu-supply" if mode == "supply" else "gwemu-cold-cycle"
    evidence = ROOT / f"out/{batch}/firmware" / name
    evidence.mkdir(parents=True, exist_ok=True)
    try:
        with machine:
            machine.command("cont")
            observations = [wait_for_firmware(machine, evidence / "initial.ppm",
                                              "retrogo" in name)]
            transitions = []
            for cycle in (1, 2):
                if mode == "cold":
                    cold_cycle(machine)
                else:
                    property(machine, "battery-present", True)
                    machine.command("cont")
                    vtor = machine.read32(0xe000ed08)
                    machine.write32(0x5800457c, 0x12345678)
                    property(machine, "battery-present", False)
                    assert machine.command("query-status")["running"]
                    assert machine.read32(0xe000ed08) == vtor
                    assert machine.read32(0x5800457c) == 0x12345678
                    property(machine, "usb-power", False)
                    assert property(machine, "powered") is False
                    assert not machine.command("query-status")["running"]
                    assert machine.read32(0x5800457c) == 0
                    with pytest.raises(AssertionError, match="supply"):
                        machine.command("cont")
                    property(machine, "usb-power", True)
                    assert property(machine, "powered") is True
                    assert not machine.command("query-status")["running"]
                    transitions.append({"cycle": cycle, "redundantSourceNoReset": True,
                                        "lossPaused": True, "restorePaused": True,
                                        "savedBattery": property(machine, "battery")})
                # The previous enabled display cannot count as new evidence:
                # reset disables LTDC; firmware must reconfigure it after cont.
                assert machine.read32(LTDC_GCR) & 1 == 0
                assert machine.read32(0x58004500) == 0
                machine.command("cont")
                observations.append(wait_for_firmware(
                    machine, evidence / f"cycle-{cycle}.ppm", "retrogo" in name,
                    after_cold=True))
            (evidence / f"{mode}.json").write_text(json.dumps({
                "profile": name, "mode": mode, "cycles": observations,
                "supplyTransitions": transitions, "sourceHashes": before,
                "scope": f"native repeated {mode} transition; no physical electrical/VBAT or RDP-transition acceptance",
            }, indent=2) + "\n")
    finally:
        assert {key: digest(path) for key, path in sources.items()} == before
