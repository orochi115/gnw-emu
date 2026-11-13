"""The private Windows native GDB port must authenticate before touching CPU state."""
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import pytest

BINARY = Path(os.environ.get('GWEMU_BINARY', Path(__file__).resolve().parents[1] / 'build/gwemu/qemu-system-arm'))
TOKEN = '72' * 32

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def connect(number):
    until = time.monotonic() + 10
    while True:
        try:
            s = socket.create_connection(('127.0.0.1', number), timeout=.5)
            s.settimeout(.5)
            return s
        except OSError:
            if time.monotonic() > until:
                raise
            time.sleep(.02)

def packet(s):
    s.sendall(b'$?#3f')
    data = b''
    while b'#' not in data:
        part = s.recv(1024)
        assert part, 'GDB disconnected before reply'
        data += part
    assert b'$T' in data or b'$S' in data, data
    s.sendall(b'+')
    return data

@contextlib.contextmanager
def native(tmp_path, token=TOKEN):
    if not BINARY.exists():
        pytest.skip('Build gwemu or set GWEMU_BINARY')
    bank = tmp_path / 'bank1.bin'
    bank.write_bytes(bytes.fromhex('0000022009000008fee7') + b'\xff' * (128 * 1024 - 10))
    flash = tmp_path / 'flash.bin'
    flash.write_bytes(b'\xff' * (1024 * 1024))
    gdb, qmp = port(), port()
    env = dict(os.environ)
    env.pop('GWEMU_GDB_TOKEN', None)
    if token is not None:
        env['GWEMU_GDB_TOKEN'] = token
    with (tmp_path / 'stderr').open('wb') as log:
        p = subprocess.Popen([str(BINARY), '-M', 'gnw-h7b0', '-display', 'none',
            '-audiodev', 'none,id=snd0', '-global', 'gnw-h7b0-sai1.audiodev=snd0',
            '-global', f'gnw-h7b0-soc.bank1-image={bank}',
            '-global', f'gnw-h7b0-soc.extflash-image={flash}',
            '-global', 'gnw-h7b0-soc.extflash-chip=c2-25-34',
            '-gdb', f'tcp:127.0.0.1:{gdb},server=on,wait=off',
            '-qmp', f'tcp:127.0.0.1:{qmp},server=on,wait=off'], env=env,
            stdout=subprocess.DEVNULL, stderr=log)
        try:
            with connect(qmp) as q:
                reader = q.makefile('rb')
                json.loads(reader.readline())
                def command(name):
                    q.sendall(json.dumps({'execute':name}).encode()+b'\n')
                    while True:
                        value=json.loads(reader.readline())
                        if 'return' in value: return value['return']
                        if 'error' in value: raise AssertionError(value)
                command('qmp_capabilities')
                yield gdb, command
        finally:
            p.terminate()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill(); p.wait(timeout=5)

def test_unauthenticated_gdb_cannot_stop_or_read_guest(tmp_path):
    with native(tmp_path) as (gdb, qmp):
        assert qmp('query-status')['running']
        with connect(gdb) as s:
            s.sendall(b'$?#3f' + b'x' * 64)
            try: data = s.recv(1024)
            except (socket.timeout, ConnectionResetError): data=b''
            assert not data, data
        assert qmp('query-status')['running'], 'Unauthenticated connection paused CPU'

def test_fragmented_token_and_reconnection_require_fresh_authentication(tmp_path):
    with native(tmp_path) as (gdb, qmp):
        with connect(gdb) as s:
            s.sendall(TOKEN[:7].encode())
            time.sleep(.03)
            assert qmp('query-status')['running']
            s.sendall(TOKEN[7:].encode())
            packet(s)
            s.sendall(b'$m000') # Disconnect in the middle of a packet.
        time.sleep(.1)
        with connect(gdb) as s:
            s.sendall(TOKEN.encode())
            packet(s)
        time.sleep(.1)
        with connect(gdb) as s:
            s.sendall(b'0' * 64 + b'$?#3f')
            try: data=s.recv(1024)
            except (socket.timeout, ConnectionResetError): data=b''
            assert not data, data

def test_plain_gdb_remains_compatible_when_token_is_absent(tmp_path):
    with native(tmp_path, None) as (gdb, _):
        with connect(gdb) as s:
            packet(s)

def test_idle_authentication_expires_without_pausing_cpu(tmp_path):
    with native(tmp_path) as (gdb, qmp):
        with connect(gdb) as idle:
            idle.settimeout(4)
            assert idle.recv(1) == b''
        assert qmp('query-status')['running']
        with connect(gdb) as s:
            s.sendall(TOKEN.encode())
            packet(s)
