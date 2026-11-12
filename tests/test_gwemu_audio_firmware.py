"""Opt-in copied firmware PCM and virtual/wall timing; WAV is not speaker latency."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np
import pytest
from PIL import Image

from harness.gnwmanager import SourceGuard
from test_gwemu_desktop import GWEMU, ROOT, Native
from test_gwemu_power_firmware import PROFILES
from test_gwemu_rtc import POLICY

REAL = pytest.mark.skipif(os.environ.get("GNW_FIRMWARE_AUDIO_TEST") != "1",
                          reason="opt in to copied local firmware audio acceptance")


def new_capture_directory(parent):
    parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="run-", dir=parent))


def assert_audible(observation):
    assert observation["audibleSeconds"] > .5 and observation["acRms"] > 10, (
        f"insufficient audible stable game PCM: {observation}")


def run_capture(command, directory, *, env, budget):
    """Parent owns native; progress never renews the complete experiment deadline."""
    directory.mkdir(parents=True, exist_ok=True)
    checkpoints = directory / "checkpoints.jsonl"
    checkpoints.write_text("")
    observations = []
    started_ns = time.monotonic_ns()
    started = started_ns / 1e9
    with (directory / "native.log").open("wb") as output:
        process = subprocess.Popen(command, stdout=output, stderr=output, env=env)
        try:
            (directory / "process.json").write_text(json.dumps({"nativePid": process.pid,
                "startedHostNs": started_ns, "args": command}, indent=2) + "\n")
            while True:
                lines = checkpoints.read_text().splitlines(keepends=True)
                complete = [line for line in lines if line.endswith("\n")]
                for line in complete[len(observations):]:
                    observations.append({**json.loads(line),
                                         "wallSeconds": time.monotonic() - started,
                                         "wavBytes": (directory / "game.wav").stat().st_size
                                         if (directory / "game.wav").exists() else 0})
                if process.poll() is not None:
                    # The read can precede the exit/final checkpoint flush.
                    for line in checkpoints.read_text().splitlines()[len(observations):]:
                        observations.append({**json.loads(line),
                                             "wallSeconds": time.monotonic() - started,
                                             "wavBytes": (directory / "game.wav").stat().st_size
                                             if (directory / "game.wav").exists() else 0})
                    assert process.returncode == 0, (directory / "native.log").read_text()[-3000:]
                    return {"nativePid": process.pid, "startedHostNs": started_ns,
                            "wallSeconds": time.monotonic() - started,
                            "checkpoints": observations}
                if time.monotonic() - started >= budget:
                    raise TimeoutError(f"native {process.pid} exceeded total deadline {budget}s")
                time.sleep(.02)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(.5)
                except subprocess.TimeoutExpired:
                    process.kill()
            process.wait(3)


def test_capture_total_deadline_reaps_native_with_continuous_checkpoints(tmp_path):
    checkpoints = tmp_path / "checkpoints.jsonl"
    child = tmp_path / "child.py"
    pid_file = tmp_path / "pid"
    child.write_text(f"""
import os,signal,time,json
from pathlib import Path
Path({str(pid_file)!r}).write_text(str(os.getpid()))
signal.signal(signal.SIGTERM,signal.SIG_IGN)
while True:
 with Path({str(checkpoints)!r}).open('a') as f:f.write(json.dumps({{'progress':True}})+'\\n')
 time.sleep(.005)
""")
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="total deadline"):
        run_capture([sys.executable, str(child)], tmp_path, env=os.environ.copy(), budget=.3)
    assert time.monotonic() - started < 3
    assert checkpoints.read_text()
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_new_capture_cannot_reuse_a_previous_game_screenshot(tmp_path):
    previous = new_capture_directory(tmp_path)
    Image.new("RGB", (640, 480), "red").save(previous / "game.png")
    current = new_capture_directory(tmp_path)
    run_capture([sys.executable, "-c", "pass"], current, env=os.environ.copy(), budget=3)
    assert previous != current
    with pytest.raises(FileNotFoundError):
        Image.open(current / "game.png")


def test_stable_pcm_detector_rejects_a_nonzero_dc_offset(tmp_path):
    path = tmp_path / "dc.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        wav.writeframes(np.full(48000, 2, dtype="<i2").tobytes())
    with pytest.raises(AssertionError, match="audible"):
        assert_audible(pcm_observation(path))


def pcm_observation(path, start=44, end=None):
    with wave.open(str(path)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 48000)
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    # QEMU's WAV backend emits a fixed 44-byte PCM header; verify before using
    # checkpoint file positions, rather than confusing bytes with sample frames.
    assert path.read_bytes()[:4] == b"RIFF" and path.read_bytes()[36:40] == b"data"
    samples = samples[max(0, (start - 44) // 2):None if end is None else max(0, (end - 44) // 2)]
    centered = samples.astype(np.float64) - samples.mean() if len(samples) else np.array([])
    return {"durationSeconds": len(samples) / 48000,
            "nonzeroSeconds": int(np.count_nonzero(samples)) / 48000,
            "audibleSeconds": int(np.count_nonzero(np.abs(centered) > 16)) / 48000,
            "acRms": float(np.sqrt(np.mean(centered ** 2))) if len(samples) else 0,
            "rms": float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) if len(samples) else 0,
            "peak": int(np.abs(samples.astype(np.int32)).max()) if len(samples) else 0}


def timeline_for(name):
    if name == "zelda":
        return """0.5 screenshot boot.png
6 hold time 0.5
8 hold game 0.5
10 hold a 0.5
14 hold start 0.5
16 hold start 0.5
18 hold a 0.5
20 hold start 0.5
22 hold start 0.5
25 screenshot entered.png
26 checkpoint stable-start
27 hold right 1
29 hold a+b 0.5
30 checkpoint stable-middle
31 hold right 1
33 hold a+b 0.5
34 checkpoint stable-end
34.1 screenshot game.png
35 quit
"""
    if name == "mario":
        return """0.5 screenshot boot.png
6 hold time 0.5
8 hold game 0.5
10 hold a 0.5
12 hold a 0.5
14 hold start 0.5
18 screenshot entered.png
20 checkpoint stable-start
21 hold right 1
23 hold a 0.5
24 checkpoint stable-middle
25 hold right 1
27 hold a 0.5
28 checkpoint stable-end
28.1 screenshot game.png
29 quit
"""
    sd = name.startswith("sd-")
    return ("0.5 screenshot boot.png\n2 hold left+game 1\n" +
            ("10 screenshot launcher.png\n12 press a\n15 press a\n"
             "29 screenshot title.png\n30 hold start 0.5\n33 screenshot character.png\n"
             "34 hold start 0.5\n37 screenshot entered.png\n38 checkpoint stable-start\n"
             "39 hold right 1\n41 hold a+b 0.5\n42 checkpoint stable-middle\n"
             "43 hold right 1\n45 hold a+b 0.5\n46 checkpoint stable-end\n"
             "46.1 screenshot game.png\n47 quit\n" if sd else
             "5 screenshot launcher.png\n6 press a\n8 press a\n"
             "14 checkpoint stable-start\n18 checkpoint stable-middle\n22 checkpoint stable-end\n"
             "15 hold right 1\n17 hold a+b 0.5\n19 hold up 1\n21 hold a+b 0.5\n"
             "22.1 screenshot game.png\n23 quit\n"))


@REAL
@pytest.mark.parametrize("name", ["mario", "zelda", "flash-retrogo", "sd-spi1", "sd-ospi"])
def test_copied_firmware_game_audio_and_wall_clock(tmp_path, name):
    profile_path = ROOT / PROFILES["sd-retrogo" if name.startswith("sd-") else name]
    if not profile_path.exists():
        pytest.skip("local firmware profile missing")
    profile = json.loads(profile_path.read_text())
    sources = {k: (profile_path.parent / profile[k]).resolve() for k in
               ("internalFlash", "externalFlash", "bank2Flash", "sdCard") if k in profile}
    if not all(p.exists() for p in sources.values()):
        pytest.skip("local firmware/card missing")
    assert GWEMU.exists(), "build fixed gwemu artifact"
    manifest = json.loads((ROOT / "build/gwemu-manager-ram/gnw-build-manifest.json").read_text())
    assert not manifest["sourceDirty"]
    assert hashlib.sha256(GWEMU.read_bytes()).hexdigest() == manifest["artifact"]["sha256"]
    parent = ROOT / "out/gwemu-audio/firmware" / name
    directory = new_capture_directory(parent)
    (parent / "active-run.txt").write_text(str(directory) + "\n")
    names = {"internalFlash": "bank1.bin", "externalFlash": "flash.bin",
             "bank2Flash": "bank2.bin", "sdCard": "sdcard.img"}
    with SourceGuard(sources.values()) as guard:
        for key, source in sources.items():
            shutil.copyfile(source, tmp_path / names[key])
        if name.startswith("sd-"):
            assert all(shutil.which(t) for t in ("mcopy", "mdel")), "mtools required"
            card = str(tmp_path / "sdcard.img") + "@@1M"
            subprocess.run(["mcopy", "-i", card, "::/cores/fceumm.bin", str(tmp_path / "fceumm.bin")],
                           capture_output=True, check=True, timeout=30)
            subprocess.run(["mdel", "-i", card, "::/cores/*"], capture_output=True, check=True, timeout=30)
            subprocess.run(["mcopy", "-i", card, str(tmp_path / "fceumm.bin"), "::/cores/fceumm.bin"],
                           capture_output=True, check=True, timeout=30)
            subprocess.run(["mdel", "-i", card, "::/CONFIG"], capture_output=True, check=True, timeout=30)
        globals = list(POLICY) + ["gnw-h7b0-rtc.initial-epoch=1767258000",
                                  "gnw-h7b0-soc.uid=310047000b51333138343134"]
        if "bank2Flash" in sources:
            globals.append(f"gnw-h7b0-soc.bank2-image={tmp_path / 'bank2.bin'}")
        wav = directory / "game.wav"
        wiring = "ospi" if name == "sd-ospi" else "spi1"
        n = Native(tmp_path, f",sd-wiring={wiring},power-model=on,battery=80,usb-power=on,"
                   "battery-life-min=0,charge-time-min=0", globals,
                   audio=f"wav,id=snd0,path={wav},out.frequency=48000,out.channels=1")
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
            env.update(GNW_TIMELINE=str(timeline), GNW_OUT=str(directory),
                       GNW_CHECKPOINTS=str(directory / "checkpoints.jsonl"))
            result = run_capture(args, directory, env=env, budget=180 if name.startswith("sd-") else 90)
        finally:
            n.__exit__()
        checkpoints = result["checkpoints"]
        assert len(checkpoints) == 3
        assert [c["name"] for c in checkpoints] == ["stable-start", "stable-middle", "stable-end"]
        first, last = checkpoints[0], checkpoints[-1]
        virtual = (last["virtual_ns"] - first["virtual_ns"]) / 1e9
        wall = last["wallSeconds"] - first["wallSeconds"]
        assert virtual > 0 and wall > 0
        pcm = pcm_observation(wav)
        stable_pcm = pcm_observation(wav, first["wavBytes"], last["wavBytes"])
        result.update(profile=name, backend="wav", binarySha256=manifest["artifact"]["sha256"],
                      pcm=pcm, stablePcm=stable_pcm, virtualSeconds=virtual, stableWallSeconds=wall,
                      virtualPerWall=virtual / wall, sourceHashes=guard.before,
                      samplingNote="checkpoint receipt includes polling and host scheduling error",
                      scene="requires independent screenshot inspection; statistics alone do not prove gameplay")
        (directory / "acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
        for previous, current in zip(checkpoints, checkpoints[1:]):
            assert current["virtual_ns"] > previous["virtual_ns"]
            assert current["wallSeconds"] > previous["wallSeconds"]
            assert current["audio"]["produced_bytes"] > previous["audio"]["produced_bytes"]
            assert current["audio"]["consumed_bytes"] > previous["audio"]["consumed_bytes"]
        # OFW's fractional PLL yields 48003 Hz; the WAV backend resamples to
        # 48000 Hz. Guest and host rates are distinct, both checked explicitly.
        expected_guest_rate = 48003 if name in ("mario", "zelda") else 48000
        assert all(c["audio"]["configured_rate_hz"] == expected_guest_rate for c in checkpoints)
        with Image.open(directory / "game.png") as image:
            assert image.size == (640, 480)
            assert np.asarray(image.convert("RGB")).std() > 10
        assert_audible(stable_pcm)
        assert last["audio"]["consumed_bytes"] > first["audio"]["consumed_bytes"], "audio stopped in observation"
