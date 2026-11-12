"""Actual RAM manager Flash acceptance on synthetic and copied real firmware."""
import json
import shutil
import hashlib
import random
import subprocess

import pytest

from harness.gnwmanager import ManagerSession, SourceGuard, digest
from test_gwemu_desktop import Native, ROOT
from test_gwemu_manager import REAL


def native(directory, capacity, globals=()):
    machine = Native(directory, globals=globals)
    index = machine.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
    machine.args[index] = "gnw-h7b0-soc.extflash-chip=" + {
        1: "c2-25-34", 4: "c2-25-36", 64: "c2-25-3a"}[capacity >> 20]
    return machine


def evidence(name, result):
    destination = ROOT / "out/gnwmanager-ram" / (name + ".json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + "\n")


@REAL
@pytest.mark.parametrize("mib", [1, 4, 64])
def test_actual_flash_synthetic_capacity_bounds_and_persistence(tmp_path, mib):
    capacity = mib << 20
    paths = {0: tmp_path / "flash.bin", 1: tmp_path / "bank1.bin", 2: tmp_path / "bank2.bin"}
    paths[0].write_bytes(b"\xff" * capacity)
    paths[1].write_bytes(bytes.fromhex("0000012009000008fee7") + b"\xff" * ((256 << 10) - 10))
    paths[2].write_bytes(b"\xff" * (256 << 10))
    globals = [f"gnw-h7b0-soc.bank2-image={paths[2]}"]
    with ManagerSession(tmp_path, native=native(tmp_path, capacity, globals)) as session:
        result = session.run("flash", {"capacity": capacity,
                                      "paths": {str(bank): str(path) for bank, path in paths.items()}})
        assert result["status"] == "IDLE"
        assert result["rejectedBeforeSubmission"] == 50
        assert result["ltdcEnabled"]
        assert result["rtcDr"] & 0x3f  # Firmware consumed timestamp into RTC date.
        assert result["wholeChipBanks"] == [0, 1, 2]
    assert {str(bank): digest(path) for bank, path in paths.items()} == result["copyHashes"]
    # Later compressed writes supersede the first writes to each final block.
    latest = {(item["bank"], item["offset"]): item for item in result["observations"]}
    with ManagerSession(tmp_path, native=native(tmp_path, capacity, globals)) as session:
        reopened = session.run("verify-persistence", {"observations": list(latest.values())}, budget=180)
    assert reopened["persistedRegions"] == 5
    evidence(f"flash-synthetic-{mib}mib", {**result, "reopen": reopened})


@REAL
@pytest.mark.parametrize("name", ["mario", "zelda", "flash-retrogo"])
def test_copied_firmware_actual_restore_then_application_start(tmp_path, name):
    from test_gwemu_power_firmware import PROFILES

    profile_path = ROOT / PROFILES[name]
    if not profile_path.exists():
        pytest.skip("local real firmware profile absent")
    profile = json.loads(profile_path.read_text())
    sources = {key: (profile_path.parent / profile[key]).resolve()
               for key in ("internalFlash", "externalFlash", "bank2Flash") if key in profile}
    if not all(path.exists() for path in sources.values()):
        pytest.skip("local real firmware image absent")
    names = {"internalFlash": "bank1.bin", "externalFlash": "flash.bin", "bank2Flash": "bank2.bin"}
    with SourceGuard(sources.values()):
        for key, source in sources.items():
            shutil.copyfile(source, tmp_path / names[key])
        paths = {0: tmp_path / "flash.bin", 1: tmp_path / "bank1.bin", 2: tmp_path / "bank2.bin"}
        for bank in (1, 2):
            data = paths[bank].read_bytes() if paths[bank].exists() else b""
            assert len(data) <= (256 << 10)
            paths[bank].write_bytes(data + b"\xff" * ((256 << 10) - len(data)))
        before = {str(bank): digest(path) for bank, path in paths.items()}
        capacity = paths[0].stat().st_size
        globals = [f"gnw-h7b0-soc.bank2-image={paths[2]}"]
        if profile.get("deviceUid"):
            globals.append(f"gnw-h7b0-soc.uid={profile['deviceUid']}")
        elif name in ("mario", "zelda"):
            globals.append("gnw-h7b0-soc.uid=310047000b51333138343134")
        machine = native(tmp_path, capacity, globals)
        with ManagerSession(tmp_path, native=machine, source_paths=sources.values()) as session:
            result = session.run("flash", {"capacity": capacity, "restore": True,
                                          "screen": str(tmp_path / "application.ppm"),
                                          "retrogo": "retrogo" in name,
                                          "paths": {str(bank): str(path) for bank, path in paths.items()}})
            assert result["restored"] and result["copyHashes"] == before
            assert result["resetLtdcDisabled"]
            assert result["application"]["litPixels"] > 20000
            assert result["appPc"] >= 0x08000000
            evidence(f"flash-real-{name}", result)
        # OFW may save after restart; the restored hashes above precede execution.


@REAL
@pytest.mark.parametrize("wiring", ["spi1", "ospi"])
def test_actual_sd_file_api_read_write_delete_and_reopen(tmp_path, wiring):
    source = ROOT / "out/sd/sdcard.img"
    if not source.exists():
        pytest.skip("local real SD card image absent")
    assert all(shutil.which(tool) for tool in ("mtype", "mdir")), "install mtools for independent FAT acceptance"
    small = tmp_path / "gwm-sm.bin"
    large = tmp_path / "gwm-lg.bin"
    small.write_bytes(random.Random(20261113).randbytes(1037))
    large.write_bytes(random.Random(20261114).randbytes(270336))
    card = tmp_path / "card.img"
    payloads = [small, large]
    results = []
    with SourceGuard([source]):
        shutil.copyfile(source, card)
        for phase in ("write", "verify", "delete"):
            machine = Native(tmp_path, f",sd-wiring={wiring}")
            machine.args += ["-drive", f"if=sd,format=raw,file={card}"]
            with ManagerSession(tmp_path, native=machine, source_paths=[source]) as session:
                result = session.run("sd", {"phase": phase, "payloads": [str(p) for p in payloads]})
                assert result["status"] == "IDLE"
                assert result["missingDirectoryError"] == "BAD_SD_DIR"
            independent = []
            directory = subprocess.run(["mdir", "-i", str(card) + "@@1M", "::/"],
                                       capture_output=True, timeout=30)
            assert directory.returncode == 0, directory.stderr
            for path in payloads:
                read = subprocess.run(["mtype", "-i", str(card) + "@@1M", "::/" + path.name],
                                      capture_output=True, timeout=30)
                if phase == "delete":
                    assert read.returncode != 0 and not read.stdout
                else:
                    assert read.returncode == 0, read.stderr
                    assert read.stdout == path.read_bytes()
                independent.append({"name": path.name, "exit": read.returncode,
                                    "bytes": len(read.stdout),
                                    "sha256": hashlib.sha256(read.stdout).hexdigest()})
            results.append({**result, "independentFat": independent})
        evidence(f"sd-actual-{wiring}", {"phases": results, "sourceSha256": digest(source),
                                       "cardCopySha256": digest(card)})


@REAL
@pytest.mark.parametrize("wiring", ["spi1", "ospi"])
def test_actual_no_card_directory_error_is_preserved_after_idle(tmp_path, wiring):
    with ManagerSession(tmp_path, native=Native(tmp_path, f",sd-wiring={wiring}")) as session:
        result = session.run("sd-no-card", budget=240)
        assert result["error"] == "BAD_SD_FS_MOUNT"
        assert result["statusAfterCleanup"] == "IDLE"
