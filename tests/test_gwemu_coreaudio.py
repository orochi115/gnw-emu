"""Opt-in process-local CoreAudio output observation; never microphone/loopback."""
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time

import numpy as np
import pytest
from PIL import Image

from harness.gnwmanager import SourceGuard
from test_gwemu_desktop import GWEMU, ROOT, Native, configure_audio
from test_gwemu_savestate import OPT_IN, backed, prop
from test_gwemu_savestate_runtime import save
from test_gwemu_audio_firmware import new_capture_directory, timeline_for, run_capture
from test_gwemu_power_firmware import PROFILES
from test_gwemu_rtc import POLICY

HEADER = struct.Struct("<4s11I")
RECORD = struct.Struct("<QdIIIIiI")
ACTUAL = pytest.mark.skipif(sys.platform != "darwin" or os.environ.get("GNW_COREAUDIO_TEST") != "1",
                            reason="opt in to actual macOS CoreAudio output")


@pytest.fixture(scope="session")
def probe(tmp_path_factory):
    if sys.platform != "darwin":
        pytest.skip("CoreAudio observer build requires macOS")
    directory = tmp_path_factory.mktemp("coreaudio-probe")
    source = ROOT / "tests/fixtures/coreaudio_probe.c"
    commands = []
    for name, options in (("observer.dylib", ["-dynamiclib"]),
                           ("query", ["-DPROBE_TOOL"]), ("selftest", ["-DPROBE_SELFTEST"])):
        command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", *options,
                   str(source), "-framework", "CoreAudio", "-o", str(directory / name)]
        subprocess.run(command, check=True, capture_output=True, timeout=30)
        commands.append(command)
    evidence = ROOT / "out/gwemu-coreaudio"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "probe-build.json").write_text(json.dumps({"commands": commands,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "dylibSha256": hashlib.sha256((directory / 'observer.dylib').read_bytes()).hexdigest()}, indent=2) + "\n")
    return directory


def read_trace(path, *, native=True):
    data = path.read_bytes()
    assert len(data) >= HEADER.size, "truncated trace header"
    magic, version, header_size, used, contexts, registered, destroyed, overflow, failed, starts, stops, count = HEADER.unpack_from(data)
    assert (magic, version, header_size) == (b"GCA1", 1, HEADER.size), "trace ABI"
    assert not overflow and not failed, "observer overflow/registration/lifecycle failure"
    assert len(data) == HEADER.size + used, "truncated trace data"
    if native:
        assert contexts >= registered > 0 and registered == destroyed, "IOProc lifecycle"
    rows = []
    offset = HEADER.size
    while offset < len(data):
        assert len(data) - offset >= RECORD.size, "truncated record header"
        host, rate, voice, channels, flags, size, status, buffers = RECORD.unpack_from(data, offset)
        offset += RECORD.size
        assert buffers == 1 and channels == 2 and flags & 1 and not flags & 0x20, "unsupported Float32 stereo format"
        assert rate == 44100 and size > 0 and size % (channels * 4) == 0, "invalid PCM size/rate"
        assert offset + size <= len(data), "truncated PCM payload"
        pcm = np.frombuffer(data[offset:offset + size], dtype="<f4").reshape(-1, channels)
        assert np.isfinite(pcm).all(), "nonfinite PCM"
        if native:
            assert status == 0, "native IOProc returned error"
        rows.append({"hostNs": host, "rate": rate, "voice": voice, "pcm": pcm})
        offset += size
    assert rows and len(rows) == count, "no/incomplete callbacks"
    return {"contexts": contexts, "registered": registered, "destroyed": destroyed,
            "starts": starts, "stops": stops, "callbackCount": count}, rows


def signal_stats(rows, start=0, end=2 ** 64 - 1):
    selected = [r for r in rows if start <= r["hostNs"] <= end]
    stereo = np.concatenate([r["pcm"] for r in selected]) if selected else np.empty((0, 2))
    samples = stereo[:, 0]
    centered = samples.astype(np.float64) - samples.mean() if len(samples) else samples
    rms = float(np.sqrt(np.mean(centered ** 2))) if len(samples) else 0
    peak_hz = 0
    if len(samples) > 100:
        spectrum = np.abs(np.fft.rfft(centered * np.hanning(len(samples))))
        peak_hz = (int(np.argmax(spectrum[1:])) + 1) * 44100 / len(samples)
    times = [r["hostNs"] for r in selected]
    return {"callbacks": len(selected), "durationSeconds": len(samples) / 44100,
            "acRms": rms, "absoluteRms": float(np.sqrt(np.mean(stereo ** 2, axis=0)).max()) if len(samples) else 0,
            "maxChannelDifference": float(np.abs(stereo[:, 0] - stereo[:, 1]).max()) if len(samples) else 0,
            "audibleSeconds": int(np.count_nonzero(np.abs(centered) > 16 / 32768)) / 44100,
            "peakHz": peak_hz, "maxCallbackGapMs": max(np.diff(sorted(times)), default=0) / 1e6}


def assert_tone(stats, frequency):
    assert stats["callbacks"] > 0 and stats["durationSeconds"] > .5, "no stable callbacks"
    assert stats["acRms"] > .01, "silent/DC PCM"
    assert abs(stats["peakHz"] - frequency) < frequency * .02, "wrong pitch"
    assert stats["maxChannelDifference"] <= 1e-6, "mono output differs between host channels"


def assert_quiet(stats, *, paused=False):
    assert stats["absoluteRms"] <= 1e-6, "quiet PCM leak"
    if not paused:
        assert stats["callbacks"] > 0 and stats["durationSeconds"] > .5, "no muted callbacks"


def test_probe_forwards_callback_client_status_and_pcm(probe, tmp_path):
    path = tmp_path / "selftest.bin"
    subprocess.run([str(probe / "selftest")], env={**os.environ, "COREAUDIO_PROBE_OUTPUT": str(path)},
                   check=True, timeout=5)
    header, rows = read_trace(path, native=False)
    assert header["callbackCount"] == 2
    np.testing.assert_array_equal(rows[0]["pcm"].ravel(), np.arange(32, dtype=np.float32) / 64)


def test_probe_overflow_keeps_original_callback_behavior(probe, tmp_path):
    path = tmp_path / "overflow.bin"
    subprocess.run([str(probe / "selftest"), "overflow"],
                   env={**os.environ, "COREAUDIO_PROBE_OUTPUT": str(path)}, check=True, timeout=5)
    with pytest.raises(AssertionError, match="overflow"):
        read_trace(path, native=False)


@pytest.mark.parametrize("content", [b"", b"GCA1", HEADER.pack(b"GCA1", 1, HEADER.size, 8, 1, 1, 1, 0, 0, 1, 1, 1)])
def test_trace_rejects_truncation(tmp_path, content):
    path = tmp_path / "bad.bin"
    path.write_bytes(content)
    with pytest.raises(AssertionError, match="truncated"):
        read_trace(path)


@pytest.mark.parametrize("frequency,amplitude", [(1000, 0), (500, .3)])
def test_tone_detector_rejects_silence_and_wrong_pitch(frequency, amplitude):
    values = (.02 + amplitude * np.sin(2 * math.pi * frequency * np.arange(44100) / 44100)).astype(np.float32)
    stats = signal_stats([{"hostNs": 1, "pcm": np.column_stack([values, values])}])
    with pytest.raises(AssertionError, match="silent/DC|wrong pitch"):
        assert_tone(stats, 1000)


def test_quiet_detector_rejects_sound_only_in_right_channel():
    pcm = np.column_stack([np.zeros(44100), np.ones(44100)]).astype(np.float32)
    with pytest.raises(AssertionError, match="quiet PCM leak"):
        assert_quiet(signal_stats([{"hostNs": 1, "pcm": pcm}]))


def test_trace_rejects_missing_observer_output(tmp_path):
    with pytest.raises(FileNotFoundError):
        read_trace(tmp_path / "absent.bin")


@pytest.mark.parametrize("payload", [b"", struct.pack("<2f", float('nan'), 0)])
def test_trace_rejects_empty_and_nonfinite_pcm(tmp_path, payload):
    path = tmp_path / "bad.bin"
    record = RECORD.pack(1, 44100, 0, 2, 9, len(payload), 0, 1) + payload
    path.write_bytes(HEADER.pack(b"GCA1", 1, HEADER.size, len(record), 1, 1, 1, 0, 0, 1, 1, 1) + record)
    with pytest.raises(AssertionError, match="invalid PCM|nonfinite"):
        read_trace(path)


def query_device(probe):
    result = subprocess.run([str(probe / "query")], check=True, capture_output=True, text=True, timeout=5)
    device = json.loads(result.stdout)
    assert device["status"] == 0 and device["device"] > 0, "no default audio output"
    return device


def preflight_device(probe):
    device = query_device(probe)
    # QEMU audio_buffer_frames rounds its default 11610us to nearest frame.
    desired = min(device["maxFrames"], max(device["minFrames"], int(44100 * 11610 / 1e6 + .5)))
    assert device["rate"] == 44100 and device["channels"] == 2 and device["bits"] == 32 and device["flags"] & 1
    assert device["frames"] == desired, f"device frame-size prerequisite: {device}, expected {desired}"
    return device


def same_device(before, after):
    for field in ("device", "rate", "channels", "flags", "bits", "frames", "minFrames", "maxFrames"):
        assert before[field] == after[field], f"output device configuration changed: {before} -> {after}"


def artifact():
    assert GWEMU.exists(), "fixed gwemu missing"
    manifest = json.loads((ROOT / "build/gwemu-manager-ram/gnw-build-manifest.json").read_text())
    assert not manifest["sourceDirty"]
    digest = hashlib.sha256(GWEMU.read_bytes()).hexdigest()
    assert digest == manifest["artifact"]["sha256"]
    return digest


def probe_env(probe, output):
    return {"DYLD_INSERT_LIBRARIES": str(probe / "observer.dylib"), "COREAUDIO_PROBE_OUTPUT": str(output)}


def probe_identity(probe):
    return {"sourceSha256": hashlib.sha256((ROOT / 'tests/fixtures/coreaudio_probe.c').read_bytes()).hexdigest(),
            "dylib": str(probe / "observer.dylib"),
            "dylibSha256": hashlib.sha256((probe / 'observer.dylib').read_bytes()).hexdigest()}


@ACTUAL
def test_actual_coreaudio_tone_mute_pause_and_restore(probe, tmp_path):
    digest = artifact()
    directory = new_capture_directory(ROOT / "out/gwemu-coreaudio/synthetic")
    before = preflight_device(probe)
    report = {"binarySha256": digest, "probe": probe_identity(probe), "deviceBefore": before,
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
        with n:
            report.update(nativePid=n.process.pid, args=n.args)
            persist()
            (directory / "process.json").write_text(json.dumps({"nativePid": n.process.pid,
                "args": n.args, "startedHostNs": time.monotonic_ns()}, indent=2) + "\n")
            configure_audio(n)
            n.write32(0x40020010, 0)
            pcm = struct.pack("<960h", *[round(12000 * math.sin(2 * math.pi * i / 48)) for i in range(960)])
            n.test(f"write 0x24000000 {len(pcm)} 0x{pcm.hex()}")
            n.write32(0x40020010, 1 | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 11) | (1 << 13))
            n.command("cont")

            def phase(name, frequency=None, quiet=False):
                marker = {"name": name, "expectedHz": frequency, "quiet": quiet, "status": "settling"}
                report["phases"].append(marker)
                persist()
                time.sleep(.3)
                marker.update(startNs=time.monotonic_ns(), status="capturing")
                persist()
                time.sleep(.85)
                marker.update(endNs=time.monotonic_ns(), status="captured")
                persist()

            phase("tone", 1000)
            n.muted(True); phase("muted", quiet=True)
            n.muted(False); phase("unmuted", 1000)
            n.command("stop"); phase("paused", quiet=True)
            n.command("cont"); phase("resumed", 1000)
            state = tmp_path / "tone.bin"
            save(n, state)
            acr1 = n.read32(0x40015804)
            n.write32(0x40015804, acr1 & ~(1 << 16))
            n.write32(0x40015804, acr1 | (2 << 20))
            n.command("cont"); phase("future-half-rate", 500)
            n.command("stop"); prop(n, "load-state", state)
            n.command("cont"); phase("restored-tone", 1000)
    except BaseException as exc:
        report["experimentError"] = repr(exc)
        raise
    finally:
        report["returncode"] = n.process.poll() if n.process else None
        (directory / "native.log").write_bytes(n.stderr_output)
        try:
            report["deviceAfter"] = query_device(probe)
        except Exception as exc:
            report["deviceAfterError"] = repr(exc)
        finally:
            persist()
    assert "deviceAfter" in report, report.get("deviceAfterError")
    same_device(before, report["deviceAfter"])
    header, rows = read_trace(directory / "callbacks.bin")
    report["trace"] = header
    for phase in report["phases"]:
        stats = signal_stats(rows, phase["startNs"], phase["endNs"])
        phase["output"] = stats
        persist()
        if phase["quiet"]:
            assert_quiet(stats, paused=phase["name"] == "paused")
        else:
            assert_tone(stats, phase["expectedHz"])
    assert report["returncode"] == 0
    assert "coreaudio:" not in n.stderr_output.decode(), "CoreAudio backend error"
    report["validation"] = "passed"
    persist()


@ACTUAL
@pytest.mark.parametrize("name", ["mario", "zelda", "flash-retrogo", "sd-spi1", "sd-ospi"])
def test_actual_copied_firmware_coreaudio(probe, tmp_path, name):
    digest = artifact()
    profile_path = ROOT / PROFILES["sd-retrogo" if name.startswith("sd-") else name]
    assert profile_path.exists(), "local firmware profile missing"
    profile = json.loads(profile_path.read_text())
    sources = {key: (profile_path.parent / profile[key]).resolve() for key in
               ("internalFlash", "externalFlash", "bank2Flash", "sdCard") if key in profile}
    assert all(p.exists() for p in sources.values()), "local firmware/card missing"
    directory = new_capture_directory(ROOT / "out/gwemu-coreaudio/firmware" / name)
    before = preflight_device(probe)
    report = {"profile": name, "binarySha256": digest, "probe": probe_identity(probe), "deviceBefore": before}
    names = {"internalFlash": "bank1.bin", "externalFlash": "flash.bin",
             "bank2Flash": "bank2.bin", "sdCard": "sdcard.img"}
    with SourceGuard(sources.values()) as guard:
        try:
            for key, source in sources.items():
                shutil.copyfile(source, tmp_path / names[key])
            if name.startswith("sd-"):
                assert all(shutil.which(t) for t in ("mcopy", "mdel")), "mtools required"
                card = str(tmp_path / "sdcard.img") + "@@1M"
                for command in (["mcopy", "-i", card, "::/cores/fceumm.bin", str(tmp_path / "fceumm.bin")],
                                ["mdel", "-i", card, "::/cores/*"],
                                ["mcopy", "-i", card, str(tmp_path / "fceumm.bin"), "::/cores/fceumm.bin"],
                                ["mdel", "-i", card, "::/CONFIG"]):
                    subprocess.run(command, capture_output=True, check=True, timeout=30)
            globals = list(POLICY) + ["gnw-h7b0-rtc.initial-epoch=1767258000",
                                      "gnw-h7b0-soc.uid=310047000b51333138343134"]
            if "bank2Flash" in sources:
                globals.append(f"gnw-h7b0-soc.bank2-image={tmp_path / 'bank2.bin'}")
            wiring = "ospi" if name == "sd-ospi" else "spi1"
            n = Native(tmp_path, f",sd-wiring={wiring},power-model=on,battery=80,usb-power=on,"
                       "battery-life-min=0,charge-time-min=0", globals, audio="coreaudio,id=snd0")
            try:
                args = []
                i = 0
                while i < len(n.args):
                    if n.args[i] == "-S":
                        i += 1
                    elif n.args[i] in ("-accel", "-qmp", "-qtest", "-qtest-log"):
                        i += 2
                    else:
                        args.append(n.args[i]); i += 1
                args[args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")] = (
                    "gnw-h7b0-soc.extflash-chip=" + {1: "c2-25-34", 4: "c2-25-36", 64: "c2-25-3a"}[
                        sources["externalFlash"].stat().st_size // (1 << 20)])
                args += ["-rtc", "base=2026-01-01T09:00:00,clock=vm"]
                if "sdCard" in sources:
                    args += ["-drive", f"if=sd,format=raw,file={tmp_path / 'sdcard.img'}"]
                timeline = directory / "game.tl"
                timeline.write_text(timeline_for(name))
                env = {k: v for k, v in os.environ.items() if not k.startswith(("GNW_", "GWEMU_"))}
                env.update(probe_env(probe, directory / "callbacks.bin"),
                           GNW_TIMELINE=str(timeline), GNW_OUT=str(directory),
                           GNW_CHECKPOINTS=str(directory / "checkpoints.jsonl"))
                report["args"] = args
                # run_capture owns/reaps its subprocess at an immutable deadline.
                report.update(run_capture(args, directory, env=env,
                                          budget=180 if name.startswith("sd-") else 90))
            finally:
                n.__exit__()
            checkpoints = report["checkpoints"]
            assert [c["name"] for c in checkpoints] == ["stable-start", "stable-middle", "stable-end"]
            header, rows = read_trace(directory / "callbacks.bin")
            report["trace"] = header
            # Receipt is after injection by one poll + scheduling delay.
            # Keep 100ms inside the ~8sec interval, and use the actual parent
            # monotonic origin, not a reconstructed post-exit/parsing time.
            origin = report["startedHostNs"]
            start = origin + int(checkpoints[0]["wallSeconds"] * 1e9) + 100_000_000
            end = origin + int(checkpoints[-1]["wallSeconds"] * 1e9) - 100_000_000
            report["stablePcm"] = signal_stats(rows, start, end)
            report["stableHostWindowNs"] = [start, end]
            report["windowNote"] = "actual parent monotonic origin; checkpoint receipt includes polling/scheduling error"
            stats = report["stablePcm"]
            assert stats["callbacks"] > 0 and stats["audibleSeconds"] > .5 and stats["acRms"] > 10 / 32768, stats
            assert stats["maxChannelDifference"] <= 1e-6, "mono game output differs between host channels"
            rate = 48003 if name in ("mario", "zelda") else 48000
            for previous, current in zip(checkpoints, checkpoints[1:]):
                assert current["virtual_ns"] > previous["virtual_ns"]
                assert current["audio"]["produced_bytes"] > previous["audio"]["produced_bytes"]
                assert current["audio"]["consumed_bytes"] > previous["audio"]["consumed_bytes"]
            assert all(c["audio"]["configured_rate_hz"] == rate for c in checkpoints)
            with Image.open(directory / "game.png") as image:
                assert image.size == (640, 480) and np.asarray(image.convert("RGB")).std() > 10
            assert "coreaudio:" not in (directory / "native.log").read_text(), "CoreAudio backend error"
        except BaseException as exc:
            report["experimentError"] = repr(exc)
            raise
        finally:
            report.update(sourceHashes=guard.before)
            try:
                report["deviceAfter"] = query_device(probe)
            except Exception as exc:
                report["deviceAfterError"] = repr(exc)
            finally:
                (directory / "acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
            if "deviceAfter" in report:
                same_device(before, report["deviceAfter"])
            elif "experimentError" not in report:
                raise AssertionError(report.get("deviceAfterError"))
