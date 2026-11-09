"""Real QEMU display wire contract; no screenshot polling transport."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time

import pytest
from qemu.qmp.legacy import QEMUMonitorProtocol

ROOT = Path(__file__).resolve().parents[1]
QEMU = Path(os.environ.get("GNW_QEMU", ROOT / "build/qemu-system-arm"))
FW = ROOT.parent / "firmware"
HEADER = struct.Struct("<4sHHIIQQIIIIIIQ")


def header(kind, sequence=0, pixel=0, maximum=0):
    return HEADER.pack(b"GNWF", 1, kind, 64, 0, sequence, 0,
                       0, 0, 0, pixel, maximum, 0, 0)


def recv_exact(sock, length):
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise EOFError("display closed")
        data.extend(chunk)
    return bytes(data)


def start(tmp_path, extra=""):
    # macOS AF_UNIX paths are limited to 104 bytes, unlike pytest's long TMPDIR.
    qmp_tmp = tempfile.TemporaryDirectory(prefix="gnw-qmp-", dir="/tmp")
    qmp_path = str(Path(qmp_tmp.name) / "qmp.sock")
    machine = (f"gnw-zelda,internal={FW / 'internal_flash_backup_zelda.bin'},"
               f"external={FW / 'flash_backup_zelda.bin'}" + extra)
    proc = subprocess.Popen([str(QEMU), "-M", machine, "-display", "none", "-S",
                             "-qmp", f"unix:{qmp_path},server=on,wait=off"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    proc.qmp_tmp = qmp_tmp
    deadline = time.monotonic() + 5
    while not Path(qmp_path).exists() and proc.poll() is None and time.monotonic() < deadline:
        time.sleep(.01)
    if proc.poll() is not None:
        qmp_tmp.cleanup()
        pytest.fail(proc.stderr.read().decode())
    qmp = QEMUMonitorProtocol(qmp_path)
    qmp.connect()
    return proc, qmp


def finish(proc, qmp):
    try:
        try:
            qmp.cmd("quit")
        except EOFError:
            pass  # QEMU may close QMP while processing quit; await the process.
    finally:
        try:
            qmp.close()
        except EOFError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait()
        proc.qmp_tmp.cleanup()


def test_handshake_while_paused_and_ack_backpressure(tmp_path):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0)); listener.listen(); listener.settimeout(5)
    proc, qmp = start(tmp_path, f",frame-endpoint=127.0.0.1:{listener.getsockname()[1]}")
    try:
        conn, _ = listener.accept(); conn.settimeout(3)
        with conn:
            hello = HEADER.unpack(recv_exact(conn, 64))
            assert hello[:5] == (b"GNWF", 1, 1, 64, 0)
            assert hello[11] == 16 * 1024 * 1024
            ack = header(2, pixel=1, maximum=16 * 1024 * 1024)
            # Exercise partial control reads, not just write boundaries.
            conn.sendall(ack[:17]); conn.sendall(ack[17:])
            frame = HEADER.unpack(recv_exact(conn, 64))
            assert frame[2] == 3
            assert frame[7:11] == (320, 240, 1280, 1)
            pixels = recv_exact(conn, frame[4])
            assert len(pixels) == 320 * 240 * 4
            assert pixels[3::4] == b"\xff" * (320 * 240)
            conn.settimeout(.12)
            with pytest.raises(socket.timeout):
                conn.recv(1)  # No second frame can pile up before ACK.
            conn.sendall(header(4, frame[5])); conn.settimeout(3)
            next_frame = HEADER.unpack(recv_exact(conn, 64))
            assert next_frame[5] > frame[5]
            recv_exact(conn, next_frame[4])
    finally:
        finish(proc, qmp); listener.close()


def test_bad_handshake_disconnects_without_corrupting_qmp(tmp_path):
    listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(); listener.settimeout(5)
    proc, qmp = start(tmp_path, f",frame-endpoint=127.0.0.1:{listener.getsockname()[1]}")
    try:
        conn, _ = listener.accept(); conn.settimeout(3)
        with conn:
            recv_exact(conn, 64)
            conn.sendall(b"BAD!" + header(2)[4:])
            assert conn.recv(1) == b""
        assert qmp.cmd("query-status")["status"] == "prelaunch"
    finally:
        finish(proc, qmp); listener.close()

def test_transport_pixels_match_composed_backlit_surface_and_resize(tmp_path):
    from harness import GnW
    from test_backlight import MMIO, configure_panel, DAC1
    internal = tmp_path / 'internal.bin'; external = tmp_path / 'external.bin'
    internal.write_bytes(struct.pack('<II', 0x20010000, 0x08000009) + b'\xfe\xe7')
    external.write_bytes(b'\xff' * 4096)
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(); listener.settimeout(5)
    gw = GnW(internal=str(internal), external=str(external))
    gw.args[2] += f',frame-endpoint=127.0.0.1:{listener.getsockname()[1]}'
    qtest_path = gw.tmp / 'qtest.sock'
    gw.args += ['-qtest', f'unix:{qtest_path},server=on,wait=off', '-qtest-log', '/dev/null']
    try:
        with gw:
            conn, _ = listener.accept(); conn.settimeout(3)
            with conn:
                recv_exact(conn,64); conn.sendall(header(2,pixel=1,maximum=16*1024*1024))
                io = MMIO(gw, qtest_path)
                try:
                    configure_panel(io); io.write(DAC1,1)
                    for level in (4095,2048,0):
                        io.write(DAC1+8,level)
                        expected = gw.frame().convert('RGBA')
                        for _ in range(20):
                            frame = HEADER.unpack(recv_exact(conn,64)); pixels = recv_exact(conn,frame[4])
                            conn.sendall(header(4,frame[5]))
                            if frame[7:9] == expected.size and pixels == expected.tobytes():
                                break
                        else:
                            pytest.fail('display transport differs from composed/backlit surface')
                finally:
                    io.close()
    finally:
        listener.close()
