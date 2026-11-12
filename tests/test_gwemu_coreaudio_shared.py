"""Actual independent CoreAudio client coexistence, using owned output only."""
import json
import hashlib
import os
import select
import struct
import subprocess
import sys
import time

import pytest

from test_gwemu_coreaudio import (ACTUAL, probe, artifact, probe_env, probe_identity,
    preflight_device, query_device, same_device, read_trace, signal_stats, assert_tone,
    assert_quiet, HEADER)
from test_gwemu_desktop import ROOT, configure_audio
from test_gwemu_audio_firmware import new_capture_directory
from test_gwemu_savestate import OPT_IN, backed, prop
from test_gwemu_savestate_runtime import save
import math


class JsonPipe:
    def __init__(self, stream):
        self.stream = stream
        self.buffer = bytearray()

    def line(self, timeout=3):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.stream], [], [], remaining)[0]:
                raise TimeoutError("peer JSON line deadline")
            chunk = os.read(self.stream.fileno(), 4096)
            if not chunk:
                raise EOFError("peer closed its output")
            self.buffer.extend(chunk)
            assert len(self.buffer) <= 16384, "oversized peer response"
        line, _, rest = self.buffer.partition(b"\n")
        self.buffer = bytearray(rest)
        return json.loads(line)


def test_peer_partial_line_still_has_total_deadline():
    child = subprocess.Popen([sys.executable, "-c",
        "import sys,time;sys.stdout.write('{\"partial\":');sys.stdout.flush();time.sleep(10)"],
        stdout=subprocess.PIPE)
    try:
        start = time.monotonic()
        with pytest.raises(TimeoutError, match="line deadline"):
            JsonPipe(child.stdout).line(.15)
        assert time.monotonic() - start < 1
    finally:
        child.terminate(); child.wait(3); child.stdout.close()


class Peer:
    def __init__(self, executable, directory):
        self.executable, self.directory = executable, directory
        self.process = self.log = self.reader = None
        self.observations = []

    def persist(self):
        (self.directory / "peer.json").write_text(json.dumps({"pid": self.process.pid if self.process else None,
            "args": [str(self.executable)], "observations": self.observations}, indent=2) + "\n")

    def __enter__(self):
        try:
            self.log = (self.directory / "peer.log").open("wb")
            env = {k: v for k, v in os.environ.items() if not k.startswith(("GNW_", "GWEMU_", "COREAUDIO_PROBE_"))
                   and k != "DYLD_INSERT_LIBRARIES"}
            self.process = subprocess.Popen([str(self.executable)], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=self.log, env=env)
            self.persist()
            self.reader = JsonPipe(self.process.stdout)
            ready = self.reader.line()
            assert ready["event"] == "ready" and ready["pid"] == self.process.pid
            self.observations.append(ready); self.persist()
            deadline = time.monotonic() + 3
            while True:
                current = self.stats()
                if current["callbacks"] >= 2: break
                assert time.monotonic() < deadline, "peer IOProc did not run"
                time.sleep(.02)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def stats(self):
        self.process.stdin.write(b"stats\n"); self.process.stdin.flush()
        result = self.reader.line()
        assert result["event"] == "stats"
        self.observations.append(result); self.persist()
        assert result["runningStatus"] == 0 and result["running"] == 1
        return result

    def __exit__(self, *_args):
        try:
            if self.process and self.process.poll() is None:
                try:
                    self.process.stdin.write(b"quit\n"); self.process.stdin.flush()
                    closed = self.reader.line()
                    self.observations.append(closed); self.persist()
                    assert closed["event"] == "closed" and closed["stopStatus"] == closed["destroyStatus"] == 0
                    assert self.process.wait(3) == 0
                finally:
                    if self.process.poll() is None:
                        self.process.terminate()
                        try: self.process.wait(2)
                        except subprocess.TimeoutExpired:
                            self.process.kill(); self.process.wait(2)
        finally:
            if self.process:
                for stream in (self.process.stdin, self.process.stdout):
                    if stream and not stream.closed: stream.close()
            if self.log and not self.log.closed: self.log.close()


@pytest.fixture(scope="session")
def peer_executable(tmp_path_factory):
    if sys.platform != "darwin": pytest.skip("CoreAudio peer requires macOS")
    path = tmp_path_factory.mktemp("coreaudio-peer") / "peer"
    source = ROOT / "tests/fixtures/coreaudio_peer.c"
    command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
        str(source), "-framework", "CoreAudio", "-o", str(path)]
    subprocess.run(command,
        capture_output=True, check=True, timeout=30)
    path.with_suffix(".json").write_text(json.dumps({"command": command,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "binarySha256": hashlib.sha256(path.read_bytes()).hexdigest()}, indent=2) + "\n")
    return path


@ACTUAL
def test_actual_shared_device_starts_and_recovers_own_audio(probe, peer_executable, tmp_path):
    digest = artifact()
    directory = new_capture_directory(ROOT / "out/gwemu-coreaudio-sharing/actual")
    before = preflight_device(probe)
    report = {"binarySha256": digest, "probe": probe_identity(probe),
              "peerBuild": json.loads(peer_executable.with_suffix(".json").read_text()), "deviceBefore": before,
              "phases": [], "validation": "pending"}

    def persist():
        pending = directory / "acceptance.tmp"
        pending.write_text(json.dumps(report, indent=2) + "\n")
        pending.replace(directory / "acceptance.json")

    persist()
    n = backed(tmp_path / "session", OPT_IN)
    n.environment = probe_env(probe, directory / "callbacks.bin")
    n.stderr_path = directory / "native.log"
    n.args[n.args.index("-accel") + 1] = "tcg"
    n.args[n.args.index("-audiodev") + 1] = "coreaudio,id=snd0"
    try:
        with Peer(peer_executable, directory) as peer:
            report["deviceWithPeer"] = query_device(probe)
            # The query runs in another process: DeviceIsRunning is local to it.
            # Somewhere plus the peer's own advancing callbacks proves coexistence.
            assert report["deviceWithPeer"]["runningSomewhere"] == 1
            assert report["deviceWithPeer"]["device"] == peer.observations[0]["device"]
            same_device(before, report["deviceWithPeer"])
            persist()
            with n:
                report.update(nativePid=n.process.pid, args=n.args); persist()
                configure_audio(n)
                n.write32(0x40020010, 0)
                pcm = struct.pack("<960h", *[round(12000 * math.sin(2 * math.pi * i / 48)) for i in range(960)])
                n.test(f"write 0x24000000 {len(pcm)} 0x{pcm.hex()}")
                n.write32(0x40020010, 1 | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 11) | (1 << 13))
                n.command("cont")

                def phase(name, frequency=None, quiet=False):
                    previous = peer.stats()["callbacks"]
                    marker = {"name": name, "expectedHz": frequency, "quiet": quiet,
                              "peerBefore": previous, "status": "settling"}
                    report["phases"].append(marker); persist()
                    time.sleep(.3)
                    marker.update(startNs=time.monotonic_ns(), status="capturing"); persist()
                    time.sleep(.85)
                    marker.update(endNs=time.monotonic_ns(), status="captured",
                                  peerAfter=peer.stats()["callbacks"]); persist()
                    assert marker["peerAfter"] > previous, "peer stopped during gwemu operation"

                phase("initial-tone", 1000)
                n.command("stop"); phase("paused", quiet=True)
                n.command("cont"); phase("resumed", 1000)
                n.muted(True); phase("muted", quiet=True)
                n.muted(False); phase("unmuted", 1000)
                state = tmp_path / "tone.bin"; save(n, state)
                acr1 = n.read32(0x40015804)
                n.write32(0x40015804, acr1 & ~(1 << 16))
                n.write32(0x40015804, acr1 | (2 << 20))
                n.command("cont"); phase("new-voice", 500)
                n.command("stop"); prop(n, "load-state", state)
                n.command("cont"); phase("restored", 1000)
            first = peer.stats()["callbacks"]
            time.sleep(.1)
            report["peerAfterNativeClosed"] = [first, peer.stats()["callbacks"]]
            assert report["peerAfterNativeClosed"][1] > first
            persist()
    except BaseException as exc:
        report["experimentError"] = repr(exc)
        raise
    finally:
        report["nativeReturncode"] = n.process.poll() if n.process else None
        trace = directory / "callbacks.bin"
        if trace.exists() and trace.stat().st_size >= HEADER.size:
            report["rawTraceHeader"] = list(HEADER.unpack_from(trace.read_bytes()[:HEADER.size]))
            report["rawTraceHeader"][0] = report["rawTraceHeader"][0].decode()
        try: report["deviceAfter"] = query_device(probe)
        except Exception as exc: report["deviceAfterError"] = repr(exc)
        persist()
    assert "deviceAfter" in report
    same_device(before, report["deviceAfter"])
    header, rows = read_trace(trace)
    report["trace"] = header
    for phase in report["phases"]:
        stats = signal_stats(rows, phase["startNs"], phase["endNs"])
        phase["output"] = stats; persist()
        if phase["quiet"]: assert_quiet(stats, paused=phase["name"] == "paused")
        else: assert_tone(stats, phase["expectedHz"])
    assert report["nativeReturncode"] == 0
    assert "coreaudio:" not in (directory / "native.log").read_text()
    report["validation"] = "passed"; persist()
