"""gnwmanager subprocess supervision and opt-in actual RAM firmware probes.

Build: GNWMANAGER_PYTHON=python3.13 scripts/build_gnwmanager_acceptance.sh
Run: GWEMU_MANAGER_TEST=1 GWEMU_BINARY=build/gwemu-savestate/qemu-system-arm \
     build/gnwmanager-python/bin/python -m pytest -q tests/test_gwemu_manager.py
Synthetic probes fail (rather than skip) when an opted-in prerequisite is absent.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
REAL = pytest.mark.skipif(os.environ.get("GWEMU_MANAGER_TEST") != "1",
                          reason="opt in to actual gnwmanager RAM firmware probes")


def child(tmp_path, body):
    path = tmp_path / "worker.py"
    path.write_text(body)
    return [sys.executable, "-u", str(path)]


def assert_reaped(pid):
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_total_deadline_reaps_worker_despite_continuous_progress(tmp_path):
    from harness.gnwmanager import WorkerDeadline, run_worker

    pid_file = tmp_path / "pid"
    command = child(tmp_path, f"""
import os, signal, time
from pathlib import Path
Path({str(pid_file)!r}).write_text(str(os.getpid()))
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    print('progress', flush=True)
    time.sleep(.005)
""")
    started = time.monotonic()
    with pytest.raises(WorkerDeadline, match="total deadline") as failure:
        run_worker(command, budget=.3)
    assert "progress" in failure.value.stdout
    assert time.monotonic() - started < 3
    assert_reaped(int(pid_file.read_text()))


def test_worker_disconnect_is_reported_and_reaped(tmp_path):
    from harness.gnwmanager import WorkerFailure, run_worker

    pid_file = tmp_path / "pid"
    command = child(tmp_path, f"""
import os, sys
from pathlib import Path
Path({str(pid_file)!r}).write_text(str(os.getpid()))
print('GDB peer disconnected', file=sys.stderr)
sys.exit(17)
""")
    with pytest.raises(WorkerFailure, match="exit 17") as failure:
        run_worker(command, budget=3)
    assert "GDB peer disconnected" in failure.value.stderr
    assert_reaped(int(pid_file.read_text()))


def test_worker_result_must_be_a_json_object(tmp_path):
    from harness.gnwmanager import WorkerFailure, run_worker

    with pytest.raises(WorkerFailure, match="JSON object"):
        run_worker(child(tmp_path, "print('[]')\n"), budget=3)


def test_source_guard_checks_hash_on_failure(tmp_path):
    from harness.gnwmanager import SourceGuard

    source = tmp_path / "original.bin"
    source.write_bytes(b"original")
    with pytest.raises(AssertionError, match="source changed"):
        with SourceGuard([source]):
            source.write_bytes(b"modified")
            raise RuntimeError("worker disconnected")


def test_firmware_manifest_rejects_different_uploaded_bytes(tmp_path):
    from harness.gnwmanager import validate_firmware

    firmware = tmp_path / "firmware.bin"
    firmware.write_bytes(b"unexpected")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"artifacts": {"firmware": {
        "sha256": hashlib.sha256(b"expected").hexdigest(), "size": 8}}}))
    with pytest.raises(AssertionError, match="firmware differs"):
        validate_firmware(manifest, firmware)


@pytest.mark.parametrize("settings,accepted", [
    ({"DEBUG": "0", "OPT": "-Os"}, True),
    ({"DEBUG": "1"}, False),
    ({"OPT": "-O0"}, False),
])
def test_cached_manager_objects_require_same_effective_compilation_settings(tmp_path, settings, accepted):
    source = tmp_path / "source"
    patch = source / "gnwmanager/gnw_patch"
    patch.mkdir(parents=True)
    for repository in (source, patch):
        subprocess.run(["git", "init", "-q", str(repository)], check=True, timeout=5)
        subprocess.run(["git", "-C", str(repository), "-c", "user.name=Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty",
                        "-qm", "fixture"], check=True, timeout=5)
    compiler_dir = tmp_path / "toolchain"
    compiler_dir.mkdir()
    compiler = compiler_dir / "arm-none-eabi-gcc"
    compiler.write_text("#!/bin/sh\necho fixture-compiler\n")
    compiler.chmod(0o755)
    build = tmp_path / "build"
    build.mkdir()
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("DEBUG", "OPT", "MAKEFLAGS")}
    environment["GCC_PATH"] = str(compiler_dir)
    command = [sys.executable, str(ROOT / "scripts/gnwmanager-build-manifest.py"),
               "check", str(source), str(build)]
    initial = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=5)
    assert initial.returncode == 0, initial.stderr
    cached = build / "cached.o"
    cached.write_bytes(b"do not rebuild with different flags")
    before = (build / "gnwmanager-build-config.json").read_bytes()
    changed = subprocess.run(command, env={**environment, **settings}, capture_output=True,
                             text=True, timeout=5)
    assert (changed.returncode == 0) == accepted, changed.stderr
    assert cached.read_bytes() == b"do not rebuild with different flags"
    assert (build / "gnwmanager-build-config.json").read_bytes() == before


def test_manager_probes_do_not_depend_on_legacy_binary(monkeypatch, tmp_path):
    import conftest

    class Item:
        def __init__(self, filename):
            self.path = Path(filename)
            self.marks = []

        def add_marker(self, marker):
            self.marks.append(marker)

    manager = Item("tests/test_gwemu_manager.py")
    legacy = Item("tests/test_gnw.py")
    monkeypatch.setattr(conftest, "QEMU", tmp_path / "missing-legacy")
    conftest.pytest_collection_modifyitems(None, [manager, legacy])
    assert not manager.marks, "actual manager probes must fail if gwemu is missing, not skip via legacy"
    assert len(legacy.marks) == 1


@pytest.mark.parametrize("alias_kind", ["symlink", "hardlink"])
def test_source_alias_cannot_be_mounted_as_an_experimental_image(tmp_path, alias_kind):
    from harness.gnwmanager import ManagerSession

    source = tmp_path / "original.bin"
    source.write_bytes(b"original")
    alias = tmp_path / "flash-copy.bin"
    if alias_kind == "symlink":
        alias.symlink_to(source)
    else:
        os.link(source, alias)
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}")

    class Native:
        args = [sys.executable, "-global", f"gnw-h7b0-soc.extflash-image={alias}"]

        def __enter__(self):
            pytest.fail("a protected original image was passed to native startup")

        def __exit__(self, *_args):
            pass

    with pytest.raises(AssertionError, match="original source mounted"):
        with ManagerSession(tmp_path, native=Native(), source_paths=[source],
                            python=sys.executable, manifest=manifest):
            pass


@REAL
def test_actual_ram_firmware_baseline(tmp_path):
    from harness.gnwmanager import ManagerSession

    with ManagerSession(tmp_path) as session:
        result = session.run("baseline")
        assert result["status"] == "IDLE"
        assert result["flashBytes"] == 1024 * 1024
        assert result["eraseBytes"] == 4096
        assert result["ramBytes"] == 65792
        assert result["registerRoundtrip"] == "restored"
        assert result["xpsrRoundtrip"] == "restored"
        assert result["registers"]["xpsr"] & (1 << 24)
        assert "xpsrError" not in result["registers"]
        assert result["packetSize"] >= 2 * 4096 + 32
        assert result["firmwareBytes"] == 49432
        assert result["loadedPc"] >= 0x240E6800
        evidence = ROOT / "out/gnwmanager-ram"
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / "baseline-acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
    assert session.native.process.poll() == 0
    assert not session.native.qmp_path.exists()
    assert_reaped(session.last_worker_pid)


@REAL
def test_actual_msp_identity_when_guest_selects_psp(tmp_path):
    from harness.gnwmanager import ManagerSession

    with ManagerSession(tmp_path) as session:
        result = session.run("stack-selection")
        assert result["selected"]["sp"] == result["selected"]["psp"] == 0x20008000
        assert result["selected"]["msp"] == 0x20010000
        assert result["inactiveMspWrite"] == "rejected"
        assert result["resetRestoredMsp"]
        (ROOT / "out/gnwmanager-ram/stack-selection-acceptance.json").write_text(
            json.dumps(result, indent=2) + "\n")


@REAL
def test_gdb_connect_resume_reset_cannot_bypass_supply_gate(tmp_path):
    from harness.gnwmanager import ManagerSession
    from test_gwemu_desktop import Native

    native = Native(tmp_path, ",power-model=on,battery-present=off,usb-power=off,"
                    "battery-life-min=0,charge-time-min=0")
    with ManagerSession(tmp_path, native=native) as session:
        assert not native.command("query-status")["running"]
        result = session.run("unpowered")
        assert result["counter"] == 0x1234
        assert not native.command("query-status")["running"]
        assert native.command("qom-get", {"path": "/machine", "property": "powered"}) is False
        (ROOT / "out/gnwmanager-ram/supply-gate-acceptance.json").write_text(
            json.dumps(result, indent=2) + "\n")


@REAL
@pytest.mark.parametrize("failure", ["timeout", "disconnect"])
def test_actual_native_is_reaped_when_api_worker_fails(tmp_path, failure):
    from harness.gnwmanager import ManagerSession, WorkerDeadline, WorkerFailure

    source = tmp_path / "source.bin"
    source.write_bytes(b"protected source")
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    command = child(tmp_path, ("import time\nwhile True:\n print('progress', flush=True)\n time.sleep(.01)\n"
                               if failure == "timeout" else "raise ConnectionError('GDB disconnected')\n"))
    session = ManagerSession(tmp_path / "session", source_paths=[source])
    with pytest.raises(WorkerDeadline if failure == "timeout" else WorkerFailure):
        with session:
            session.run("baseline", budget=.3 if failure == "timeout" else 3,
                        command=command)
    assert session.native.process.poll() is not None
    assert_reaped(session.native.process.pid)
    assert_reaped(session.last_worker_pid)
    assert not session.native.qmp_path.exists()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


@REAL
def test_application_observation_remains_inside_parent_total_deadline(tmp_path):
    from harness.gnwmanager import ManagerSession, WorkerDeadline

    # The synthetic guest loops forever and never enables LTDC. Its display
    # wait must be killed by the same supervisor as Flash/API work.
    session = ManagerSession(tmp_path)
    with pytest.raises(WorkerDeadline) as failure:
        with session:
            session.run("application-observation", {
                "screen": str(tmp_path / "never-rendered.ppm"), "retrogo": False}, budget=1)
    assert "application observation" in failure.value.stderr
    assert_reaped(session.last_worker_pid)
    assert_reaped(session.native.process.pid)
