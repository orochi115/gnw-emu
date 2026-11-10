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

def test_live_mute_keeps_guest_audio_running_and_resumes_same_process(tmp_path):
    output = tmp_path / 'mute.wav'
    with GnW('zelda', audio=True, extra=[
        '-M', 'audio-muted=on',
        '-audiodev', f'wav,id=gnw,path={output}',
        '-global', 'gnw-dma.audiodev=gnw',
    ]) as gw:
        gw.run(3000)
        gw.press('game', 150, 1000)
        gw.press('a', 150, 6000)
        pid = gw.proc.pid
        assert gw.qmp.cmd('qom-get', path='/machine', property='audio-muted') is True
        muted = output.read_bytes()[44:]
        assert len(muted) > 4000 and not any(muted)
        gw.qmp.cmd('qom-set', path='/machine', property='audio-muted', value=False)
        gw.run(6000)
        audible = output.read_bytes()[44 + len(muted):]
        assert any(audible)
        assert gw.proc.pid == pid
        gw.qmp.cmd('qom-set', path='/machine', property='audio-muted', value=True)
        start = len(output.read_bytes())
        gw.run(3000)
        # Discard 500 ms of already mixed device PCM at the transition.
        silence = output.read_bytes()[start + 44100 * 4 // 2:]
        assert len(silence) > 4000 and not any(silence)
        assert gw.proc.pid == pid
