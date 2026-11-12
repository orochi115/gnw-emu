"""Native gwemu desktop transport, identity, locking and audible mute tests."""
import contextlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import wave

import pytest

ROOT = Path(__file__).resolve().parents[1]
GWEMU = Path(os.environ.get("GWEMU_BINARY", ROOT / "build/gwemu-fork/qemu-system-arm"))
pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
HEADER = struct.Struct("<4sHHIIQQIIIIIIQ")


def control(kind, sequence=0, pixel=0, maximum=0):
    return HEADER.pack(b"GNWF", 1, kind, 64, 0, sequence, 0,
                       0, 0, 0, pixel, maximum, 0, 0)


def receive(sock, length):
    chunks = bytearray()
    while len(chunks) < length:
        part = sock.recv(length - len(chunks))
        if not part:
            raise EOFError("frame transport closed")
        chunks.extend(part)
    return bytes(chunks)


class Native:
    def __init__(self, directory, machine="", globals=(), audio="none,id=snd0", environment=None):
        self.environment = dict(environment or {})
        self.stderr_output = b""
        self.stderr_path = None
        self.stderr_handle = None
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.internal = self.directory / "bank1.bin"
        self.external = self.directory / "flash.bin"
        if not self.internal.exists():
            self.internal.write_bytes(struct.pack("<II", 0x20010000, 0x08000009)
                                      + b"\xfe\xe7" + b"\xff" * (128 * 1024 - 10))
        if not self.external.exists():
            self.external.write_bytes(b"\xff" * (1024 * 1024))
        self.sockets = tempfile.TemporaryDirectory(prefix="gw-native-", dir="/tmp")
        self.qmp_path = Path(self.sockets.name) / "qmp"
        self.qtest_path = Path(self.sockets.name) / "qtest"
        self.args = [str(GWEMU), "-M", "gnw-h7b0" + machine, "-display", "none", "-S",
                     "-accel", "qtest", "-qtest", f"unix:{self.qtest_path},server=on,wait=off",
                     "-qtest-log", "/dev/null",
                     "-qmp", f"unix:{self.qmp_path},server=on,wait=off",
                     "-global", f"gnw-h7b0-soc.bank1-image={self.internal}",
                     "-global", f"gnw-h7b0-soc.extflash-image={self.external}",
                     "-global", "gnw-h7b0-soc.extflash-chip=c2-25-34",
                     "-audiodev", audio, "-global", "gnw-h7b0-sai1.audiodev=snd0"]
        for item in globals:
            self.args += ["-global", item]
        self.process = None
        self.qmp = self.qtest = self.stream = self.test_stream = None
        self.serial = 0

    def __enter__(self):
        try:
            if self.stderr_path:
                self.stderr_handle = Path(self.stderr_path).open("wb")
            self.process = subprocess.Popen(
                self.args, stdout=subprocess.DEVNULL,
                stderr=self.stderr_handle if self.stderr_handle else subprocess.PIPE,
                env={**{k: v for k, v in os.environ.items()
                        if not k.startswith(("GNW_", "GWEMU_"))}, **self.environment})
            deadline = time.monotonic() + 5
            while not self.qmp_path.exists() or not self.qtest_path.exists():
                if self.process.poll() is not None:
                    raise AssertionError("native startup failed: " + self.startup_stderr())
                if time.monotonic() > deadline:
                    raise AssertionError("native startup timed out")
                time.sleep(.01)
            self.qmp = socket.socket(socket.AF_UNIX)
            self.qmp.settimeout(3)
            while True:
                try:
                    self.qmp.connect(str(self.qmp_path))
                    break
                except ConnectionRefusedError:
                    if self.process.poll() is not None:
                        raise AssertionError("native startup failed: " + self.startup_stderr())
                    if time.monotonic() > deadline:
                        raise AssertionError("native QMP connection timed out")
                    time.sleep(.01)
            self.stream = self.qmp.makefile("rb")
            assert "QMP" in json.loads(self.stream.readline())
            self.command("qmp_capabilities")
            self.qtest = socket.socket(socket.AF_UNIX)
            self.qtest.settimeout(3)
            self.qtest.connect(str(self.qtest_path))
            self.test_stream = self.qtest.makefile("rb")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def startup_stderr(self):
        if self.stderr_path:
            return Path(self.stderr_path).read_text()
        return self.process.stderr.read().decode()

    def command(self, name, arguments=None):
        self.serial += 1
        request = {"execute": name, "id": self.serial}
        if arguments is not None:
            request["arguments"] = arguments
        self.qmp.sendall(json.dumps(request).encode() + b"\n")
        while True:
            line = self.stream.readline()
            if not line:
                raise EOFError("QMP closed")
            reply = json.loads(line)
            if reply.get("id") == self.serial:
                assert "error" not in reply, reply
                return reply["return"]

    def test(self, text):
        self.qtest.sendall(text.encode() + b"\n")
        reply = self.test_stream.readline().decode().strip()
        assert reply.startswith("OK"), reply
        return reply[2:].strip()

    def write32(self, address, value):
        self.test(f"writel {address:#x} {value:#x}")

    def read32(self, address):
        return int(self.test(f"readl {address:#x}"), 0)

    def step(self, ns=10_000_000, count=1):
        for _ in range(count):
            self.test(f"clock_step {ns}")

    def muted(self, value=None):
        args = {"path": "/machine/soc/sai1", "property": "audio-muted"}
        if value is None:
            return self.command("qom-get", args)
        self.command("qom-set", {**args, "value": value})

    def __exit__(self, *_args):
        if self.process and self.process.poll() is None:
            if self.qmp:
                with contextlib.suppress(EOFError, OSError, AssertionError):
                    self.command("quit")
            try:
                self.process.wait(3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(3)
        for item in (self.stream, self.test_stream, self.qmp, self.qtest):
            if item:
                item.close()
        if self.process and self.process.stderr and not self.process.stderr.closed:
            self.stderr_output = self.process.stderr.read()
            self.process.stderr.close()
        if self.stderr_handle and not self.stderr_handle.closed:
            self.stderr_handle.close()
            self.stderr_output = Path(self.stderr_path).read_bytes()
        self.sockets.cleanup()


@contextlib.contextmanager
def display_listener():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(3)
        yield listener


@pytest.mark.parametrize("suffix", ["override", "", "0", "65536", "1x"])
def test_frame_endpoint_rejects_parser_override_without_connecting(tmp_path, suffix):
    with display_listener() as listener:
        port = ("1,,addr=localhost:" + str(listener.getsockname()[1])
                if suffix == "override" else suffix)
        machine = Native(tmp_path, ",frame-endpoint=127.0.0.1:" + port)
        try:
            result = subprocess.run(machine.args, capture_output=True, timeout=5)
            assert result.returncode != 0
            assert b"endpoint must be" in result.stderr
            listener.settimeout(.1)
            with pytest.raises(socket.timeout):
                listener.accept()
        finally:
            machine.__exit__()


def test_frames_are_paused_rgba_with_ack_backpressure_and_real_surface(tmp_path):
    from PIL import Image
    with display_listener() as listener:
        endpoint = listener.getsockname()[1]
        with Native(tmp_path, f",frame-endpoint=127.0.0.1:{endpoint}") as machine:
            with listener.accept()[0] as client:
                client.settimeout(3)
                hello = HEADER.unpack(receive(client, 64))
                assert hello == HEADER.unpack(control(1, pixel=1, maximum=16 * 1024 * 1024))
                ack = control(2, pixel=1, maximum=16 * 1024 * 1024)
                client.sendall(ack[:17])
                client.sendall(ack[17:])
                frame = HEADER.unpack(receive(client, 64))
                assert frame[2] == 3 and frame[7:11] == (640, 480, 2560, 1)
                assert frame[6] > 0
                pixels = receive(client, frame[4])
                assert pixels[3::4] == b"\xff" * (640 * 480)
                client.settimeout(.08)
                with pytest.raises(socket.timeout):
                    client.recv(1)
                client.settimeout(3)
                # This existing native recovery-screen path publishes known blue pixels.
                machine.write32(0x50001000 + 0x9c, 0xff0000ff)
                machine.write32(0x50001000 + 0x88, 32 << 16)
                machine.write32(0x50001000 + 0x8c, 16 << 16)
                machine.write32(0x50001000 + 0x18, 1)
                machine.write32(0x50001000 + 0x24, 1)
                screenshot = tmp_path / "composed.png"
                machine.command("screendump", {"filename": str(screenshot), "format": "png"})
                expected = Image.open(screenshot).convert("RGBA")
                assert expected.size == (64, 32)
                assert expected.getpixel((0, 0)) == (0, 0, 255, 255)
                for _ in range(10):
                    client.sendall(control(4, frame[5]))
                    next_frame = HEADER.unpack(receive(client, 64))
                    assert next_frame[5] > frame[5]
                    frame = next_frame
                    pixels = receive(client, frame[4])
                    if frame[7:9] == expected.size and pixels == expected.tobytes():
                        break
                else:
                    pytest.fail("transport does not match the composed surface")
                assert machine.command("query-status")["status"] == "prelaunch"


def test_bad_display_handshake_disconnects_without_breaking_qmp(tmp_path):
    with display_listener() as listener:
        with Native(tmp_path, f",frame-endpoint=127.0.0.1:{listener.getsockname()[1]}") as machine:
            with listener.accept()[0] as client:
                client.settimeout(3)
                receive(client, 64)
                client.sendall(b"BAD!" + control(2, pixel=1, maximum=1024)[4:])
                assert client.recv(1) == b""
            assert machine.command("query-status")["status"] == "prelaunch"


def test_uid_is_raw_profile_bytes_and_default_stays_synthetic(tmp_path):
    explicit = "1234567890AbCdEf2468aCe0"
    with Native(tmp_path / "explicit", globals=[f"gnw-h7b0-soc.uid={explicit}"]) as machine:
        output = tmp_path / "uid.bin"
        machine.command("pmemsave", {"val": 0x08fff800, "size": 12, "filename": str(output)})
        assert output.read_bytes() == bytes.fromhex(explicit)
    with Native(tmp_path / "default") as machine:
        output = tmp_path / "default.bin"
        machine.command("pmemsave", {"val": 0x08fff800, "size": 12, "filename": str(output)})
        assert output.read_bytes().hex() == "455157474d00554d01000000"


@pytest.mark.parametrize("uid", ["00", "x" * 24, "0" * 26])
def test_invalid_uid_rejected_before_flash_is_padded(tmp_path, uid):
    machine = Native(tmp_path, globals=[f"gnw-h7b0-soc.uid={uid}"])
    original = machine.internal.read_bytes()
    try:
        result = subprocess.run(machine.args, capture_output=True, timeout=3)
        assert result.returncode != 0
        assert b"UID must contain exactly 24 hexadecimal digits" in result.stderr
        assert machine.internal.read_bytes() == original
    finally:
        machine.sockets.cleanup()


def test_native_lock_rejects_second_process_before_touching_images(tmp_path):
    lock = tmp_path / "machine.lock"
    with Native(tmp_path / "first", f",session-lock={lock}"):
        second = Native(tmp_path / "second", f",session-lock={lock}")
        original = second.internal.read_bytes()
        try:
            result = subprocess.run(second.args, capture_output=True, timeout=3)
            assert result.returncode != 0
            assert b"session lock occupied" in result.stderr
            assert second.internal.read_bytes() == original
        finally:
            second.sockets.cleanup()
    # Lock is released by process exit, without deleting its inode.
    with Native(tmp_path / "after", f",session-lock={lock}") as machine:
        assert machine.command("query-status")["status"] == "prelaunch"


def configure_audio(machine):
    # 64 MHz HSI / 25 * 96 / 20 = 12.288 MHz; MCKDIV=1 -> 48 kHz.
    rcc = 0x58024400
    machine.write32(rcc + 0x28, (2 << 4) | (25 << 12) | (2 << 20))
    machine.write32(rcc + 0x38, 95 | (19 << 9) | (1 << 16) | (1 << 24))
    machine.write32(rcc + 0x50, 1)
    machine.write32(rcc, machine.read32(rcc) | (1 << 26))
    machine.write32(rcc + 0xf0, 1 << 22)
    # A stable nonzero mono sample, circular memory->SAI1 DMA request 87.
    samples = struct.pack("<h", 4096) * 960
    machine.test(f"write 0x24000000 {len(samples)} 0x{samples.hex()}")
    machine.write32(0x40020800, 87)
    machine.write32(0x40020014, 960)
    machine.write32(0x40020018, 0x40015820)
    machine.write32(0x4002001c, 0x24000000)
    machine.write32(0x40015804, (1 << 16) | (1 << 17) | (4 << 5) | (1 << 12))
    machine.write32(0x40020010, 1 | (1 << 6) | (1 << 8) | (1 << 10)
                      | (1 << 11) | (1 << 13))


def test_mute_changes_actual_audio_and_survives_voice_recreation(tmp_path):
    wav = tmp_path / "output.wav"
    with Native(tmp_path, globals=["gnw-h7b0-sai1.audio-muted=off"],
                audio=f"wav,id=snd0,path={wav},out.frequency=48000,out.channels=1") as machine:
        assert machine.muted() is False
        configure_audio(machine)
        machine.command("cont")
        phases = []
        for muted, recreate in [(False, False), (True, False), (True, True), (False, False)]:
            machine.muted(muted)
            assert machine.muted() is muted
            if recreate:
                # Disable/re-enable SAI at a new MCKDIV to reopen its host voice.
                acr1 = machine.read32(0x40015804)
                machine.write32(0x40015804, acr1 & ~(1 << 16))
                machine.write32(0x40015804, acr1 | (2 << 20))
            machine.step(count=30)  # discard already mixed samples at transition
            start = wav.stat().st_size
            machine.step(count=70)
            end = wav.stat().st_size
            assert end - start > 8000, "audio backend produced no output"
            phases.append((start, end))
    with wave.open(str(wav), "rb") as captured:
        assert captured.getnchannels() == 1
        assert captured.getsampwidth() == 2
    data = wav.read_bytes()
    chunks = [data[start:end] for start, end in phases]
    assert any(chunks[0]) and any(chunks[3]), "unmuted signal is silent"
    assert not any(chunks[1]) and not any(chunks[2]), "mute leaked audible samples"
