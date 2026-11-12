"""Isolated, parent-owned native sessions with a hard gnwmanager API deadline.

The API runs in a subprocess: manager's status-progress timeouts cannot extend
the parent's total wall deadline. Original images are observed, never mounted.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
BUDGETS = {"baseline": 30, "flash": 180, "sd": 240}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class SourceGuard:
    """Compare full original-image hashes even when the experiment fails."""

    def __init__(self, paths):
        self.paths = tuple(Path(path).resolve() for path in paths)
        self.before = {}

    def snapshot(self):
        return {str(path): {"size": path.stat().st_size, "sha256": digest(path)}
                for path in self.paths}

    def __enter__(self):
        self.before = self.snapshot()
        return self

    def __exit__(self, *_args):
        assert self.snapshot() == self.before, "protected source changed during manager experiment"


class WorkerFailure(RuntimeError):
    def __init__(self, message, *, stdout="", stderr="", pid=None):
        super().__init__(message)
        self.stdout, self.stderr, self.pid = stdout, stderr, pid


class WorkerDeadline(WorkerFailure, TimeoutError):
    pass


def run_worker(command, *, budget, env=None, cwd=ROOT):
    """Run one complete experiment; reap it on success, error or deadline."""
    if budget <= 0:
        raise ValueError("worker budget must be positive")
    started = time.monotonic()
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=env, cwd=cwd)
    try:
        try:
            stdout, stderr = process.communicate(timeout=budget)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=.5)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=3)
            raise WorkerDeadline(f"manager API exceeded total deadline of {budget}s",
                                 stdout=stdout, stderr=stderr, pid=process.pid)
        if process.returncode:
            raise WorkerFailure(f"manager API worker exit {process.returncode}: {stderr[-2000:]}",
                                stdout=stdout, stderr=stderr, pid=process.pid)
        try:
            result = json.loads(stdout)
            if not isinstance(result, dict):
                raise ValueError("not an object")
        except (ValueError, TypeError) as error:
            raise WorkerFailure("manager API worker did not return a JSON object",
                                stdout=stdout, stderr=stderr, pid=process.pid) from error
        return {**result, "workerPid": process.pid,
                "wallSeconds": time.monotonic() - started}
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)
        process.stdout.close()
        process.stderr.close()


def validate_firmware(manifest_path, firmware_path):
    manifest = json.loads(Path(manifest_path).read_text())
    expected = manifest["artifacts"]["firmware"]
    actual = {"size": Path(firmware_path).stat().st_size, "sha256": digest(firmware_path)}
    assert all(actual[key] == expected[key] for key in actual), "uploaded firmware differs from manifest"
    return manifest


class ManagerSession:
    """Own a single temporary gwemu; workers connect only to its loopback stub.

    The caller supplies copied/synthetic files inside directory. A custom Native
    may add banks, frame observers, power or SD wiring for later acceptance. All
    operations within this context receive an independent complete API deadline.
    """

    def __init__(self, directory, *, native=None, source_paths=(), python=None, manifest=None):
        from test_gwemu_desktop import Native

        self.native = native if native is not None else Native(Path(directory))
        self.sources = SourceGuard(source_paths)
        self.python = Path(python or os.environ.get(
            "GNWMANAGER_PYTHON_ENV", ROOT / "build/gnwmanager-python/bin/python")).absolute()
        self.manifest = Path(manifest or os.environ.get(
            "GNWMANAGER_MANIFEST", ROOT / "build/gnwmanager-ram-final/gnwmanager-build-manifest.json"))
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        if "-gdb" in self.native.args:
            raise ValueError("ManagerSession must allocate its own GDB endpoint")
        if "-accel" in self.native.args:
            index = self.native.args.index("-accel")
            assert self.native.args[index + 1] == "qtest", "unexpected accelerator"
            del self.native.args[index:index + 2]
        if "-icount" not in self.native.args:
            self.native.args += ["-icount", "shift=0,sleep=off"]
        self.native.args += ["-gdb", f"tcp:127.0.0.1:{self.port}"]
        # QEMU's monitor chardev permits one client per endpoint. Give the API
        # worker its own QMP monitor so the parent retains its lifecycle handle.
        self.worker_qmp_path = Path(getattr(self.native, "qmp_path", Path(directory) / "qmp")).with_name(
            "manager-qmp")
        self.native.args += ["-qmp", f"unix:{self.worker_qmp_path},server=on,wait=off"]
        self.last_worker_pid = None

    def __enter__(self):
        self.sources.__enter__()
        try:
            assert Path(self.native.args[0]).exists(), "build gwemu before opting in to manager probes"
            assert self.python.exists(), "build the gnwmanager acceptance Python environment first"
            assert self.manifest.exists(), "run scripts/build_gnwmanager_acceptance.sh first"
            # Resolve image aliases too: a symlink is not a temporary copy.
            # These are the board's Flash globals and the SD drive's file=.
            for arg in self.native.args:
                for field in arg.split(","):
                    if "=" not in field:
                        continue
                    name, value = field.split("=", 1)
                    if name.endswith("-image") or name == "file":
                        image = Path(value)
                        assert not any(image.exists() and image.samefile(path)
                                       for path in self.sources.paths), "original source mounted directly"
            self.native.__enter__()
            return self
        except BaseException:
            try:
                self.native.__exit__(*sys.exc_info())
            finally:
                self.sources.__exit__(*sys.exc_info())
            raise

    def run(self, operation, parameters=None, *, budget=None, command=None):
        budget = BUDGETS.get(operation, 30) if budget is None else budget
        config = {"host": "127.0.0.1", "port": self.port, "operation": operation,
                  "parameters": {"qmpPath": str(self.worker_qmp_path), **(parameters or {})},
                  "manifest": str(self.manifest.absolute())}
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join((str(ROOT), str(ROOT / "tests")))
        command = command if command is not None else [
            str(self.python), "-m", "harness.gnwmanager_worker", json.dumps(config)]
        try:
            result = run_worker(command, budget=budget, env=env)
            self.last_worker_pid = result["workerPid"]
            return result
        except WorkerFailure as error:
            self.last_worker_pid = error.pid
            raise

    def __exit__(self, *args):
        try:
            self.native.__exit__(*args)
        finally:
            self.sources.__exit__(*args)
