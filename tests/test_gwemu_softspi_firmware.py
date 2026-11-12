"""Opt-in local SD Retro-Go acceptance on copies, never on source images."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import time

import pytest

from test_gwemu_desktop import ROOT, Native
from test_sdcard import ELF, NM, symbols

pytestmark = pytest.mark.skipif(
    os.environ.get("GNW_FIRMWARE_SD_TEST") != "1" or not ELF.exists() or not NM or not all(shutil.which(tool) for tool in ("mtype", "mcopy", "mdel")),
    reason="opt in with local SD firmware, ELF and nm",
)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def memory(machine, address, size):
    return bytes.fromhex(machine.test(f"read {address:#x} {size}")[2:])


def press(machine, *keys, duration=.2, settle=1):
    for down in (True, False):
        machine.command("input-send-event", {"events": [
            {"type": "key", "data": {"down": down,
             "key": {"type": "qcode", "data": key}}} for key in keys]})
        time.sleep(duration if down else settle)
        if down and hasattr(machine, "tick_address"):
            start = machine.read32(machine.tick_address)
            # Software SPI and synchronous core file I/O can slow guest input
            # sampling. Hold for guest milliseconds, not only host wall time.
            wait_for(lambda: (machine.read32(machine.tick_address) - start) & 0xffffffff >= 400,
                     15, "firmware tick did not advance during key hold")


def wait_for(predicate, seconds, description):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, description
        time.sleep(.1)


@pytest.mark.parametrize("wiring,expected", [("spi1", 2), ("ospi", 3)])
def test_real_sd_firmware_mounts_and_runs_game_on_copies(tmp_path, wiring, expected):
    profile_path = ROOT / "out/profiles/sd-full_20261104_1021-spi1.gnw.json"
    if not profile_path.exists():
        pytest.skip("local SD profile absent")
    profile = json.loads(profile_path.read_text())
    sources = {key: (profile_path.parent / profile[key]).resolve()
               for key in ("internalFlash", "externalFlash", "bank2Flash", "sdCard")}
    if not all(path.exists() for path in sources.values()):
        pytest.skip("local SD profile image absent")
    before = {key: digest(path) for key, path in sources.items()}
    names = {"internalFlash": "bank1.bin", "externalFlash": "flash.bin",
             "bank2Flash": "bank2.bin", "sdCard": "sdcard.img"}
    for key, source in sources.items():
        shutil.copyfile(source, tmp_path / names[key])
    # Focus the copied card on NES and reset its persisted UI selection. The
    # source has many cores/covers whose slow redraw can queue extra tab keys.
    copied_card = f"{tmp_path / 'sdcard.img'}@@1M"
    subprocess.run(["mcopy", "-i", copied_card, "::/cores/fceumm.bin", str(tmp_path / "fceumm.bin")], check=True, capture_output=True)
    subprocess.run(["mdel", "-i", copied_card, "::/cores/*"], check=True, capture_output=True)
    subprocess.run(["mcopy", "-i", copied_card, str(tmp_path / "fceumm.bin"), "::/cores/fceumm.bin"], check=True, capture_output=True)
    subprocess.run(["mdel", "-i", copied_card, "::/CONFIG"], check=True, capture_output=True)
    # The ELF must describe precisely the local bank2 bytes under test.
    assert sources["bank2Flash"] == ELF.with_name("gw_retro_go_intflash.bin").resolve()
    syms = symbols()
    machine = Native(tmp_path, f",sd-wiring={wiring},power-model=on,battery=80,"
                     "usb-power=on,battery-life-min=0,charge-time-min=0",
                     globals=[f"gnw-h7b0-soc.bank2-image={tmp_path / 'bank2.bin'}",
                              "gnw-h7b0-rtc.initial-epoch=1735689600"])
    index = machine.args.index("-accel")
    del machine.args[index:index + 2]  # TCG executes firmware; QTest observes it.
    index = machine.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
    machine.args[index] = "gnw-h7b0-soc.extflash-chip=c2-25-3a"
    machine.args += ["-drive", f"if=sd,format=raw,file={tmp_path / 'sdcard.img'}"]
    evidence = ROOT / "out/gwemu-softspi-sd/firmware" / wiring
    evidence.mkdir(parents=True, exist_ok=True)
    observed = []
    def log():
        current = memory(machine, syms["logbuf"], 4096).split(b"\0")[0].decode("latin1")
        if not observed or current != observed[-1]:
            observed.append(current)
            (evidence / "observed.log").write_text("\n--- observation ---\n".join(observed))
        return current
    try:
        with machine:
            machine.command("cont")
            time.sleep(.5)
            press(machine, "left", "g", settle=2)
            wait_for(lambda: machine.read32(0xe000ed08) == 0x08100000 and
                     memory(machine, syms["fs_mounted"], 1) == b"\1" and
                     machine.read32(syms["sdcard_hw_type"]) == expected,
                     40, "SD firmware did not mount on the requested wiring")
            try:
                wait_for(lambda: "registered 'Nintendo Entertainment System'" in log(),
                         60, "NES core was not registered")
            except AssertionError:
                (evidence / "failure.log").write_text(log())
                machine.command("screendump", {"filename": str(evidence / "failure.ppm")})
                raise
            time.sleep(2)
            machine.tick_address = syms["uwTick"]
            # The source card has a saved theme/tab. Navigate through real input,
            # using read-only GUI pointers to identify NES, never forcing state.
            def selected():
                return machine.read32(syms["gui"] + 12)

            def tab_name():
                table = machine.read32(syms["gui"])
                tab = machine.read32(table + selected() * 4)
                return memory(machine, tab, 64).split(b"\0")[0].decode("latin1")

            for _ in range(32):
                if tab_name() == "nes":
                    break
                old = selected()
                press(machine, "right", settle=2)
                if selected() == old:  # horizontal coverflow swaps tab axes
                    press(machine, "down", settle=2)
            assert tab_name() == "nes", tab_name()
            machine.command("screendump", {"filename": str(evidence / "launcher.ppm")})
            press(machine, "x", settle=1)
            press(machine, "x", settle=8)
            wait_for(lambda: "fceumm" in memory(machine, syms["g_running_core_path"], 64).split(b"\0")[0].decode("latin1"),
                     20, "NES core did not start")
            wait_for(lambda: "odroid_system_emu_init: Init done." in log(), 30,
                     "game core initialization did not finish")
            time.sleep(1)
            machine.command("stop")
            registers = machine.command("human-monitor-command", {"command-line": "info registers"})
            pc = int(re.search(r"R15=([0-9a-fA-F]+)", registers)[1], 16)
            # A core can be sampled inside firmware services; its loaded path
            # is a stronger identity check than a single PC snapshot.
            machine.command("screendump", {"filename": str(evidence / "game.ppm")})
            machine.command("cont")
            press(machine, "esc", settle=1)
            machine.command("screendump", {"filename": str(evidence / "game-menu.ppm")})
            assert (evidence / "game-menu.ppm").read_bytes() != (evidence / "game.ppm").read_bytes()
            press(machine, "x", settle=1)  # Save & Continue
            press(machine, "x", settle=3)  # slot 0
            wait_for(lambda: "Saving state to" in log(), 20, "firmware did not save")
            saved_path = re.findall(r"Saving state to '([^']+)'", log())[-1]
            (evidence / "firmware.log").write_text(log())
            (evidence / "acceptance.json").write_text(json.dumps({
                "wiring": wiring, "sdcardHwType": expected, "fsMounted": 1,
                "gamePc": pc, "sourceHashes": before, "savedPath": saved_path,
            }, indent=2) + "\n")
        # Reopen the file with an independent FAT reader after QEMU flush/exit.
        saved = subprocess.run(["mtype", "-i", f"{tmp_path / 'sdcard.img'}@@1M", "::" + saved_path],
                               capture_output=True, check=True).stdout
        assert len(saved) > 100 and any(saved), "empty or missing firmware save"
        (evidence / "save.json").write_text(json.dumps({"bytes": len(saved),
            "sha256": hashlib.sha256(saved).hexdigest(), "path": saved_path}, indent=2) + "\n")
    finally:
        assert {key: digest(path) for key, path in sources.items()} == before
