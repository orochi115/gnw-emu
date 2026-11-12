"""Bounded real backup experiments; parent owns all native lifecycle."""

import contextlib
import hashlib
import importlib.resources
import json
import sys
from pathlib import Path

from harness.gnwmanager import validate_firmware


def sha(data):
    return hashlib.sha256(data).hexdigest()


def scene(backend):
    return {
        "registers": {name: backend.read_register(name) for name in ("pc", "msp", "r0", "xpsr")},
        "sram": sha(backend.read_memory(0x24030000, 4096)),
        "itcm": sha(backend.read_memory(0, 65536)),
        "rtcBackup": sha(backend.read_memory(0x58004500, 128)),
    }


def hashes(gnw):
    addresses = {"bank1": 0x08000000, "bank2": 0x08100000, "ext": 0x90000000}
    return {
        name: sha(gnw.read_memory(address, gnw.external_flash_size if name == "ext" else 256 << 10))
        for name, address in addresses.items()
    }


def capture(backend, gnw, parameters):
    from gnwmanager.full_backup import capture_backup, verify_archive

    backend.halt()
    backend.write_memory(0x24030000, bytes(range(256)) * 16)
    backend.write_register("r0", 0x1234ABCD)
    initial = scene(backend)
    calls = []
    originals = {}
    for name in ("write_memory", "write_register", "reset", "reset_and_halt", "resume"):
        originals[name] = getattr(backend, name)

        def record(*args, _name=name, **kwargs):
            calls.append(_name)
            return originals[_name](*args, **kwargs)

        setattr(backend, name, record)
    original_start = gnw.start_gnwmanager
    prefix = {}
    uploads = 0

    def start(*args, **kwargs):
        nonlocal uploads
        prefix.update(scenePreserved=scene(backend) == initial, calls=list(calls))
        uploads += 1
        return original_start(*args, **kwargs)

    gnw.start_gnwmanager = start
    manifest = capture_backup(gnw, parameters["out"], skip_ext=parameters.get("skip_ext", False))
    if not uploads:
        prefix.update(scenePreserved=scene(backend) == initial, calls=list(calls))
    assert prefix["scenePreserved"], "original registers/RAM/ITCM/RTC changed during raw capture"
    assert not prefix["calls"], f"raw capture mutated the target: {prefix['calls']}"
    verified = verify_archive(parameters["out"])
    assert verified == manifest
    return {
        "coverage": manifest["coverage"],
        "rawScenePreserved": prefix["scenePreserved"],
        "finalRawScenePreserved": scene(backend) == initial if not uploads else None,
        "rawPrefixWrites": sum(name.startswith("write") for name in prefix["calls"]),
        "rawPrefixResets": sum(name.startswith("reset") for name in prefix["calls"]),
        "managerUploads": uploads,
        "flashHashes": {
            name: metadata["sha256"]
            for filename, metadata in manifest["files"].items()
            if (name := filename[:-4]) in ("bank1", "bank2", "ext")
        },
    }


def cli_chain(config):
    """Exercise actual command dispatch against the native single-client stub."""
    import importlib

    from gnwmanager.full_backup import verify_archive
    from gnwmanager.ocdbackend import GDBBackend

    cli = importlib.import_module("gnwmanager.cli.main")
    connections = {"activeConnections": 0, "maxConnections": 0}

    class ObservedBackend(GDBBackend):
        def open(self):
            # GDBBackend.open first closes its prior connection. Count only
            # after that initialization and a successful actual connection.
            result = super().open()
            self._observed_open = True
            connections["activeConnections"] += 1
            connections["maxConnections"] = max(connections["maxConnections"], connections["activeConnections"])
            return result

        def close(self):
            try:
                return super().close()
            finally:
                if getattr(self, "_observed_open", False):
                    self._observed_open = False
                    connections["activeConnections"] -= 1

    cli.OCDBackend = {"gdb": ObservedBackend}
    out = config["parameters"]["out"]
    cli.main(
        "disable-debug",
        "--",
        "backup",
        "--out",
        out,
        "--skip-ext",
        "--",
        "restore-backup",
        out,
        "--only",
        "bank2",
        "--yes",
        "--",
        "disable-debug",
        backend="gdb",
        gdb_host=config["host"],
        gdb_port=config["port"],
        exit_on_error=False,
    )
    manifest = verify_archive(out)
    return {
        **connections,
        "coverage": manifest["coverage"],
        "commands": ["disable-debug", "backup", "restore-backup", "disable-debug"],
    }


def cli_cache_chain(config):
    """Use real manager work before and after each borrowed archive operation."""
    import importlib

    from gnwmanager import GnW
    from gnwmanager.full_backup import verify_archive
    from gnwmanager.ocdbackend import GDBBackend

    cli = importlib.import_module("gnwmanager.cli.main")
    parameters = config["parameters"]
    root = Path(parameters["out"]).parent
    payloads = [bytes([value]) * (256 << 10) for value in (0xA1, 0xA2, 0xA3)]
    files = [root / f"payload-{index}.bin" for index in range(3)]
    for path, payload in zip(files, payloads, strict=True):
        path.write_bytes(payload)
    readbacks = [root / f"readback-{index}.bin" for index in range(3)]
    connections = {"activeConnections": 0, "maxConnections": 0}

    class ObservedBackend(GDBBackend):
        def open(self):
            # GDBBackend.open first closes its prior connection. Count only
            # after that initialization and a successful actual connection.
            result = super().open()
            self._observed_open = True
            connections["activeConnections"] += 1
            connections["maxConnections"] = max(connections["maxConnections"], connections["activeConnections"])
            return result

        def close(self):
            try:
                return super().close()
            finally:
                if getattr(self, "_observed_open", False):
                    self._observed_open = False
                    connections["activeConnections"] -= 1

    # Bound a stalled guest explicitly; this changes only the worker's wait
    # budgets, never the manager implementation or success/readback checks.
    for name in ("wait_for_idle", "wait_for_all_contexts_complete", "wait_for_context_response", "get_context"):
        original = getattr(GnW, name)

        def bounded(self, *args, _original=original, **kwargs):
            kwargs["timeout"] = min(kwargs.get("timeout", 120), 2)
            return _original(self, *args, **kwargs)

        setattr(GnW, name, bounded)
    cli.OCDBackend = {"gdb": ObservedBackend}
    tokens = ["flash", "bank2", str(files[0]), "--", "backup", "--out", parameters["out"]]
    if parameters["partial"]:
        tokens.append("--skip-ext")
    tokens += [
        "--",
        "flash",
        "bank2",
        str(files[1]),
        "--",
        "dump",
        "bank2",
        str(readbacks[0]),
        "262144",
        "--",
        "restore-backup",
        parameters["out"],
        "--only",
        "bank2",
        "--yes",
        "--",
        "dump",
        "bank2",
        str(readbacks[1]),
        "262144",
        "--",
        "flash",
        "bank2",
        str(files[2]),
        "--",
        "dump",
        "bank2",
        str(readbacks[2]),
        "262144",
    ]
    options = {"backend": "gdb", "gdb_host": config["host"], "gdb_port": config["port"], "exit_on_error": False}
    caller_retained = None
    if parameters["injected"]:
        with ObservedBackend(config["host"], config["port"], resume_on_connect=False) as backend:
            gnw = GnW(backend)
            gnw.start_gnwmanager()
            cli.main(*tokens, gnw=gnw, **options)
            caller_retained = connections["activeConnections"] == 1
            assert caller_retained, "CLI closed caller-owned GDB backend"
            backend.halt()
    else:
        cli.main(*tokens, **options)
    expected = [payloads[1], payloads[0], payloads[2]]
    actual = [path.read_bytes() for path in readbacks]
    assert actual == expected, "following commands did not complete verified manager readback"
    return {
        **connections,
        "coverage": verify_archive(parameters["out"])["coverage"],
        "injected": parameters["injected"],
        "callerRetained": caller_retained,
        "readbackHashes": [sha(payload) for payload in actual],
    }


def main():
    from gnwmanager import GnW
    from gnwmanager.full_backup import BackupError, fetch_backup, restore_backup
    from gnwmanager.ocdbackend import GDBBackend

    config = json.loads(sys.argv[1])
    manifest = validate_firmware(config["manifest"], importlib.resources.files("gnwmanager") / "firmware.bin")
    parameters = config["parameters"]
    counts = {"backendOpens": 0, "flashWrites": 0}

    def factory():
        counts["backendOpens"] += 1
        return GDBBackend(config["host"], config["port"], resume_on_connect=False)

    original_flash = GnW.flash

    def flash(self, *args, **kwargs):
        counts["flashWrites"] += 1
        return original_flash(self, *args, **kwargs)

    GnW.flash = flash
    with contextlib.redirect_stdout(sys.stderr):
        operation = config["operation"]
        if operation == "cli-chain":
            result = cli_chain(config)
        elif operation == "cli-cache-chain":
            result = cli_cache_chain(config)
        elif operation in ("fetch", "fetch-rejection"):
            try:
                fetched = fetch_backup(parameters["source"], parameters["dest"])
            except BackupError as error:
                if operation != "fetch-rejection":
                    raise
                result = {**counts, "error": str(error)}
            else:
                assert operation == "fetch", "corrupt fetch unexpectedly succeeded"
                result = {**counts, "manifest": fetched}
        elif operation in ("restore-rejection", "restore-readback-error"):
            corrupted = 0
            original_read = GnW.read_memory

            def corrupt_readback(self, key, size=None):
                nonlocal corrupted
                actual = original_read(self, key, size)
                if counts["flashWrites"] == 2 and key == 0x08100000 and not corrupted:
                    corrupted += 1
                    return bytes([actual[0] ^ 1]) + actual[1:]
                return actual

            if operation == "restore-readback-error":
                GnW.read_memory = corrupt_readback
            try:
                selection = (
                    ["bank1", "bank2", "ext"] if operation == "restore-readback-error" else parameters.get("only")
                )
                restore_backup(parameters["archive"], factory, only=selection, confirm=lambda: True)
            except BackupError as error:
                expected = "Readback mismatch: bank2" if corrupted else parameters["expected"]
                assert expected.lower() in str(error).lower(), str(error)
                assert error.completed == (["bank1"] if corrupted else [])
                result = {**counts, "error": str(error), "completed": error.completed, "corruptedReadbacks": corrupted}
            else:
                raise AssertionError("invalid restore unexpectedly succeeded")
            finally:
                GnW.read_memory = original_read
        else:
            if operation == "restore":
                result = restore_backup(
                    parameters["archive"], factory, only=parameters.get("only"), confirm=lambda: True
                )
            with factory() as backend:
                gnw = GnW(backend)
                if operation == "capture":
                    result = capture(backend, gnw, parameters)
                else:
                    gnw.start_gnwmanager(force=True)
                    if operation == "mutate":
                        for bank, value in ((1, 0xA1), (2, 0xA2), (0, 0xE1)):
                            size = gnw.external_flash_size if bank == 0 else 256 << 10
                            gnw.flash(bank, 0, bytes([value]) * size)
                        result = {}
                    elif operation == "inspect":
                        result = {}
                    result["flashHashes"] = hashes(gnw)
                backend.halt()
    result.update(
        firmwareBytes=manifest["artifacts"]["firmware"]["size"],
        firmwareSha256=manifest["artifacts"]["firmware"]["sha256"],
        managerFirmwareRevision=manifest["source"]["revision"],
    )
    # Host Python and uploaded firmware have separate provenance. New backup
    # code does not imply that firmware was rebuilt at that host revision.
    import gnwmanager.cli.main
    import gnwmanager.full_backup
    import gnwmanager.gnw
    import gnwmanager.ocdbackend.gdb_backend

    result["hostSourceSha256"] = {
        "full_backup.py": sha(Path(gnwmanager.full_backup.__file__).read_bytes()),
        "gdb_backend.py": sha(Path(gnwmanager.ocdbackend.gdb_backend.__file__).read_bytes()),
        "gnw.py": sha(Path(gnwmanager.gnw.__file__).read_bytes()),
        "cli/main.py": sha(Path(sys.modules["gnwmanager.cli.main"].__file__).read_bytes()),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
