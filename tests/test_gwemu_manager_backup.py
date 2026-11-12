"""Required actual full-backup probes on new synthetic gwemu images."""

import hashlib
import json
import os
import random
import shutil
import struct
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest
from test_gwemu_desktop import GWEMU, ROOT, Native

from harness.gnwmanager import ManagerSession, digest


def images(directory, capacity=1 << 20):
    directory.mkdir(parents=True, exist_ok=True)
    paths = {"bank1": directory / "bank1.bin", "bank2": directory / "bank2.bin", "ext": directory / "flash.bin"}
    rng = random.Random(20261113)
    for name, path in paths.items():
        payload = bytearray(rng.randbytes(capacity if name == "ext" else 256 << 10))
        if name == "bank1":
            payload[:10] = struct.pack("<II", 0x20010000, 0x08000009) + b"\xfe\xe7"
        path.write_bytes(payload)
    native = Native(directory, globals=[f"gnw-h7b0-soc.bank2-image={paths['bank2']}"])
    if capacity != 1 << 20:
        index = native.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
        native.args[index] = "gnw-h7b0-soc.extflash-chip=c2-25-36"
    return native, paths


def run(session, operation, **parameters):
    config = {
        "host": "127.0.0.1",
        "port": session.port,
        "operation": operation,
        "parameters": parameters,
        "manifest": str(session.manifest.absolute()),
    }
    return session.run(
        operation,
        budget=180,
        command=[str(session.python), "-m", "harness.gnwmanager_backup_worker", json.dumps(config)],
    )


def evidence(name, native, reports):
    output = ROOT / "out/gwemu-completion/backup"
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((GWEMU.parent / "gnw-build-manifest.json").read_text())
    assert digest(GWEMU) == manifest["artifact"]["sha256"]
    assert not manifest["sourceDirty"]
    result = {
        "nativePid": native.process.pid,
        "nativeExit": native.process.returncode,
        "binarySha256": digest(GWEMU),
        "nativeRevision": manifest["revision"],
        "reports": reports,
    }
    (output / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n")
    for pid in [native.process.pid, *(report["workerPid"] for report in reports)]:
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


def test_actual_full_capture_selected_restore_and_reopen(tmp_path):
    assert GWEMU.exists(), "build pinned gwemu before required backup acceptance"
    native, paths = images(tmp_path / "device")
    before = {name: digest(path) for name, path in paths.items()}
    archive = tmp_path / "archive"
    with ManagerSession(native.directory, native=native) as session:
        captured = run(session, "capture", out=str(archive))
        assert captured["coverage"] == "complete"
        assert captured["rawScenePreserved"]
        assert captured["rawPrefixWrites"] == 0
        assert captured["rawPrefixResets"] == 0
        assert captured["flashHashes"] == before
        archive_before = {p.name: digest(p) for p in archive.iterdir()}
        changed = run(session, "mutate")
        assert all(changed["flashHashes"][name] != before[name] for name in paths)
        selected = run(session, "restore", archive=str(archive), only=["bank2"])
        assert selected["completed"] == ["bank2"]
        assert selected["flashHashes"] == {**changed["flashHashes"], "bank2": before["bank2"]}
        restored = run(session, "restore", archive=str(archive))
        assert set(restored["completed"]) == set(paths)
        assert restored["flashHashes"] == before
    assert {name: digest(path) for name, path in paths.items()} == before
    assert {p.name: digest(p) for p in archive.iterdir()} == archive_before
    reopened = Native(native.directory, globals=[f"gnw-h7b0-soc.bank2-image={paths['bank2']}"])
    with ManagerSession(reopened.directory, native=reopened) as session:
        persisted = run(session, "inspect")
        assert persisted["flashHashes"] == before
    evidence("complete-selected", native, [captured, changed, selected, restored])
    evidence("reopen", reopened, [persisted])


def test_actual_partial_capture_preserves_scene_without_manager_upload(tmp_path):
    native, paths = images(tmp_path / "device")
    before = {name: digest(path) for name, path in paths.items()}
    with ManagerSession(native.directory, native=native) as session:
        result = run(session, "capture", out=str(tmp_path / "partial"), skip_ext=True)
        assert result["coverage"] == "partial"
        assert result["rawScenePreserved"] and result["finalRawScenePreserved"]
        assert result["rawPrefixWrites"] == result["rawPrefixResets"] == 0
        assert result["managerUploads"] == 0
        assert not native.command("query-status")["running"]
    assert {name: digest(path) for name, path in paths.items()} == before
    evidence("partial-raw", native, [result])


def test_actual_capacity_mismatch_and_corrupt_archive_write_no_flash(tmp_path):
    native, _paths = images(tmp_path / "original-device")
    archive = tmp_path / "archive"
    with ManagerSession(native.directory, native=native) as session:
        captured = run(session, "capture", out=str(archive))
    evidence("capture-for-rejection", native, [captured])
    other, paths = images(tmp_path / "other-device", 4 << 20)
    before = {name: digest(path) for name, path in paths.items()}
    with ManagerSession(other.directory, native=other) as session:
        mismatch = run(session, "restore-rejection", archive=str(archive), only=["ext"], expected="capacity mismatch")
        assert mismatch["flashWrites"] == 0 and mismatch["backendOpens"] == 1
        (archive / "bank1.bin").write_bytes(b"corrupt")
        corrupt = run(session, "restore-rejection", archive=str(archive), expected="mismatch")
        assert corrupt["flashWrites"] == corrupt["backendOpens"] == 0
    assert {name: digest(path) for name, path in paths.items()} == before
    evidence("restore-rejection", other, [mismatch, corrupt])


def test_actual_legacy_archive_restore_and_offline_http_fetch(tmp_path):
    native, paths = images(tmp_path / "device")
    before = {name: digest(path) for name, path in paths.items()}
    archive = tmp_path / "archive"
    legacy = tmp_path / "legacy"
    with ManagerSession(native.directory, native=native) as session:
        captured = run(session, "capture", out=str(archive))
        shutil.copytree(archive, legacy)
        manifest = json.loads((legacy / "manifest.json").read_text())
        for field in ("format", "version", "coverage"):
            del manifest[field]
        (legacy / "manifest.json").write_text(json.dumps(manifest))
        changed = run(session, "mutate")
        restored = run(session, "restore", archive=str(legacy))
        assert restored["flashHashes"] == before

        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(tmp_path)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            fetched = run(
                session, "fetch", source=f"http://127.0.0.1:{server.server_port}/legacy", dest=str(tmp_path / "fetched")
            )
            assert fetched["backendOpens"] == 0
            assert fetched["manifest"] == manifest
            assert {p.name: digest(p) for p in (tmp_path / "fetched").iterdir()} == {
                p.name: digest(p) for p in legacy.iterdir()
            }
            (legacy / "ext.bin").write_bytes(b"corrupt")
            rejected = run(
                session,
                "fetch-rejection",
                source=f"http://127.0.0.1:{server.server_port}/legacy",
                dest=str(tmp_path / "bad-fetched"),
            )
            assert rejected["backendOpens"] == 0
            assert not (tmp_path / "bad-fetched").exists()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
    assert {name: digest(path) for name, path in paths.items()} == before
    evidence("legacy-http", native, [captured, changed, restored, fetched, rejected])


def test_actual_restore_readback_error_reports_only_verified_regions(tmp_path):
    native, paths = images(tmp_path / "device")
    before = {name: digest(path) for name, path in paths.items()}
    archive = tmp_path / "archive"
    with ManagerSession(native.directory, native=native) as session:
        captured = run(session, "capture", out=str(archive))
        archive_hashes = {p.name: digest(p) for p in archive.iterdir()}
        changed = run(session, "mutate")
        failed = run(session, "restore-readback-error", archive=str(archive))
        assert failed["completed"] == ["bank1"]
        assert failed["flashWrites"] == 2
        assert failed["corruptedReadbacks"] == 1
        assert "Readback mismatch: bank2" in failed["error"]
        assert not native.command("query-status")["running"]
        observed = run(session, "inspect")
        # Both writes happened, but only bank1 was verified when the injected
        # host readback corruption interrupted the operation. Ext never ran.
        assert observed["flashHashes"] == {**before, "ext": changed["flashHashes"]["ext"]}
        assert {p.name: digest(p) for p in archive.iterdir()} == archive_hashes
    assert {name: digest(path) for name, path in paths.items()} == observed["flashHashes"]
    evidence("readback-error", native, [captured, changed, failed, observed])


def test_actual_chained_cli_backup_restore_uses_single_gdb_client(tmp_path):
    native, paths = images(tmp_path / "device")
    before = {name: digest(path) for name, path in paths.items()}
    with ManagerSession(native.directory, native=native) as session:
        result = run(session, "cli-chain", out=str(tmp_path / "partial"))
        assert result["coverage"] == "partial"
        assert result["maxConnections"] == 1 and result["activeConnections"] == 0
        assert result["commands"] == ["disable-debug", "backup", "restore-backup", "disable-debug"]
    assert {name: digest(path) for name, path in paths.items()} == before
    evidence("cli-chain", native, [result])


@pytest.mark.parametrize("injected", [False, True], ids=["owned-cli", "injected-shell"])
@pytest.mark.parametrize("partial", [True, False], ids=["partial", "complete"])
def test_actual_chained_backup_restore_refreshes_manager_for_following_flash(tmp_path, injected, partial):
    native, paths = images(tmp_path / "device")
    before = {name: path.read_bytes() for name, path in paths.items()}
    with ManagerSession(native.directory, native=native) as session:
        result = run(session, "cli-cache-chain", out=str(tmp_path / "archive"), injected=injected, partial=partial)
        assert result["coverage"] == ("partial" if partial else "complete")
        assert result["maxConnections"] == 1 and result["activeConnections"] == 0
        assert result["readbackHashes"] == [
            hashlib.sha256(bytes([value]) * (256 << 10)).hexdigest() for value in (0xA2, 0xA1, 0xA3)
        ]
        if injected:
            assert result["callerRetained"]
    assert paths["bank1"].read_bytes() == before["bank1"]
    assert paths["ext"].read_bytes() == before["ext"]
    assert paths["bank2"].read_bytes() == bytes([0xA3]) * (256 << 10)
    evidence(
        f"cli-cache-{'injected' if injected else 'owned'}-{'partial' if partial else 'complete'}", native, [result]
    )
