"""Native regression for gwemu initialization and capacity-safe unlock baseline."""
import json
import socket
import subprocess
import time
import tempfile
from pathlib import Path
import os

import pytest

from harness.gnw import ROOT

GWEMU = Path(os.environ.get('GWEMU_BINARY', ROOT / 'build' / 'gwemu' / 'qemu-system-arm')).resolve()
BASELINE_SIZE = 0x30c3a8 + 1300


@pytest.mark.skipif(not GWEMU.exists(), reason='run sh scripts/build_gwemu.sh')
@pytest.mark.parametrize('mib,chip', [(1, 'c2-25-34'), (4, 'c2-25-36')])
def test_small_flash_initializes_and_pads_unlock_baseline(tmp_path, mib, chip):
    image = tmp_path / 'flash.bin'
    original = bytes([0x37]) * (mib * 1024 * 1024)
    image.write_bytes(original)
    sockets = tempfile.TemporaryDirectory(prefix='gnw-qmp-', dir='/tmp')
    endpoint = Path(sockets.name) / 'qmp.sock'
    args = [str(GWEMU), '-M', 'gnw-h7b0', '-S', '-display', 'none',
            '-global', f'gnw-h7b0-soc.extflash-image={image}',
            '-global', f'gnw-h7b0-soc.extflash-chip={chip}',
            '-global', 'gnw-h7b0-soc.rdp-locked=on',
            '-qmp', f'unix:{endpoint},server=on,wait=off',
            '-audiodev', 'none,id=snd0', '-global', 'gnw-h7b0-sai1.audiodev=snd0']
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(2)
    try:
        deadline = time.monotonic() + 3
        while not endpoint.exists() and time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail(process.stderr.read().decode())
            time.sleep(.02)
        client.connect(str(endpoint))
        stream = client.makefile('rb')
        assert 'QMP' in json.loads(stream.readline())
        client.sendall(b'{"execute":"qmp_capabilities","id":1}\n')
        reply = json.loads(stream.readline())
        assert reply == {'return': {}, 'id': 1}
        baseline = image.with_name(image.name + '.gnw-unlock-baseline').read_bytes()
        assert len(baseline) == BASELINE_SIZE
        available = min(len(original), BASELINE_SIZE)
        assert baseline[:available] == original[:available]
        assert baseline[available:] == b'\xff' * (BASELINE_SIZE - available)
        client.sendall(b'{"execute":"quit","id":2}\n')
        process.wait(3)
        assert image.read_bytes() == original
    finally:
        client.close()
        if process.poll() is None:
            process.kill()
        process.wait(3)
        sockets.cleanup()
