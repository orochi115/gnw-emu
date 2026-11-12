"""Actual DMA/SAI/resampler waveform acceptance, independent of guest music."""
import json
import math
import struct
import wave

import numpy as np
import pytest

from test_gwemu_desktop import GWEMU, ROOT, Native, configure_audio


def spectrum(samples, rate=48000):
    values = np.asarray(samples, dtype=np.float64)
    assert len(values) >= rate // 2, "insufficient stable PCM"
    centered = values - values.mean()
    amplitudes = np.abs(np.fft.rfft(centered * np.hanning(len(values))))
    peak = int(np.argmax(amplitudes[1:]) + 1)
    return {"peakHz": peak * rate / len(values),
            "rms": float(np.sqrt(np.mean(centered ** 2))),
            "nonzeroFraction": float(np.count_nonzero(values) / len(values)),
            "samples": len(values)}


def assert_tone(samples, expected):
    measured = spectrum(samples)
    assert measured["rms"] > 1000, f"silent/weak PCM: {measured}"
    assert measured["nonzeroFraction"] > .95, f"PCM gaps: {measured}"
    assert abs(measured["peakHz"] - expected) < expected * .02, f"wrong pitch: {measured}"
    return measured


def test_frequency_detector_rejects_half_pitch_and_silence():
    t = np.arange(48000) / 48000
    with pytest.raises(AssertionError, match="wrong pitch"):
        assert_tone(np.round(12000 * np.sin(2 * math.pi * 500 * t)), 1000)
    with pytest.raises(AssertionError, match="silent"):
        assert_tone(np.zeros(48000), 1000)


@pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
@pytest.mark.parametrize("divider,nodiv,expected", [
    (1, False, 1000), (2, False, 500), (3, False, 1000 / 3),
    (4, True, 1000),
])
def test_actual_mono_waveform_pitch_through_dma_and_resampler(tmp_path, divider, nodiv, expected):
    path = tmp_path / "tone.wav"
    with Native(tmp_path, audio=f"wav,id=snd0,path={path},out.frequency=48000,out.channels=1") as n:
        configure_audio(n)
        n.write32(0x40020010, 0)
        acr1 = n.read32(0x40015804) & ~(1 << 16)
        n.write32(0x40015804, acr1)
        pcm = struct.pack("<960h", *[
            round(12000 * math.sin(2 * math.pi * i / 48)) for i in range(960)])
        n.test(f"write 0x24000000 {len(pcm)} 0x{pcm.hex()}")
        n.write32(0x40020014, 960)
        if nodiv:
            n.write32(0x4001580c, 63)
        acr1 = (acr1 & ~(63 << 20)) | (divider << 20)
        if nodiv:
            acr1 |= 1 << 19
        n.write32(0x40015804, acr1 | (1 << 16))
        n.write32(0x40020010, 1 | (1 << 6) | (1 << 8) | (1 << 10)
                  | (1 << 11) | (1 << 13))
        n.command("cont")
        n.step(count=30)
        start = path.stat().st_size
        n.step(count=70)
        end = path.stat().st_size
    with wave.open(str(path)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 48000)
    stable = np.frombuffer(path.read_bytes()[start:end], dtype="<i2")
    measured = assert_tone(stable, expected)
    evidence = ROOT / "out/gwemu-audio"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / f"tone-{divider}-{'nodiv' if nodiv else 'mck'}.json").write_text(
        json.dumps({"divider": divider, "nodiv": nodiv, "expectedHz": expected,
                    "backend": "wav", **measured}, indent=2) + "\n")
