"""Portable QEMU audio backend receives generated guest PCM, without Electron."""
import wave
from harness import GnW

def test_qemu_audio_backend_receives_pcm(tmp_path):
    output = tmp_path / 'host.wav'
    with GnW('zelda', audio=True, extra=['-audiodev', f'wav,id=gnw,path={output}', '-global', 'gnw-dma.audiodev=gnw']) as gw:
        gw.run(3000)
        gw.press('game', 150, 1000)
        gw.press('a', 150, 6000)
    with wave.open(str(output)) as wav:
        assert wav.getnchannels() == 2
        assert wav.getnframes() > 1000
        assert any(wav.readframes(wav.getnframes()))

def test_unavailable_host_device_does_not_retry_every_dma_buffer(tmp_path, capfd):
    missing = tmp_path / 'missing' / 'host.wav'
    with GnW('zelda', audio=True, extra=['-audiodev', f'wav,id=gnw,path={missing}', '-global', 'gnw-dma.audiodev=gnw']) as gw:
        gw.run(3000)
    errors = capfd.readouterr().err
    assert errors.count("Could not create a backend for voice") <= 1
