"""Native option-byte/GDB model acceptance; never physical device protection."""
import contextlib
import hashlib
import json
from pathlib import Path
import socket
import struct
import tempfile
import time

import pytest

from test_gwemu_desktop import GWEMU, ROOT
from test_gwemu_savestate import OPT_IN, backed, prop
from test_gwemu_supply import Rsp

FLASH = 0x52002000
BANKS = (0x08000000, 0x08100000)
SIZE = 256 * 1024
CUR = (0x1c, 0x11c)
PRG = (0x20, 0x120)


class DeadlineRsp(Rsp):
    """Retain existing checksum/ACK handling with a whole-packet deadline."""
    def packet(self, payload, timeout=2):
        self.deadline = time.monotonic() + timeout
        self.remaining_bytes = 65536
        return super().packet(payload)

    def receive(self, size):
        self.remaining_bytes -= size
        assert self.remaining_bytes >= 0, "oversized GDB response"
        data = bytearray()
        while len(data) < size:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("GDB packet total deadline")
            self.socket.settimeout(remaining)
            part = self.socket.recv(size - len(data))
            assert part, "GDB closed"
            data.extend(part)
        return bytes(data)


def test_partial_gdb_packet_has_total_deadline():
    client, peer = socket.socketpair()
    rsp = DeadlineRsp.__new__(DeadlineRsp)
    rsp.socket = client
    try:
        peer.sendall(b"+$partial")
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            rsp.packet("?", timeout=.1)
        assert time.monotonic() - started < .8
    finally:
        rsp.close()
        peer.close()


def hashes(directory):
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in ("bank1.bin", "bank2.bin", "flash.bin")}


@contextlib.contextmanager
def observed(directory, *, instant=False):
    if not GWEMU.exists():
        pytest.skip("build gwemu first")
    directory.mkdir(parents=True, exist_ok=True)
    for name, pattern in (("bank1.bin", 37), ("bank2.bin", 53), ("flash.bin", 71)):
        path = directory / name
        if not path.exists():
            size = 1024 * 1024 if name == "flash.bin" else SIZE
            data = bytearray(bytes((i * pattern + 11) & 255 for i in range(256)) * (size // 256))
            if name == "bank1.bin":
                # Thumb: read bank1 sentinel and store to SRAM, then loop.
                code = struct.pack("<II6HII", 0x20010000, 0x08000009,
                    0x4802, 0x6801, 0x4a02, 0x6011, 0xe7fe, 0xbf00,
                    0x08000100, 0x20000200)
                data[:len(code)] = code
            path.write_bytes(data)
    n = backed(directory, OPT_IN if instant else "")
    n.gdb_path = n.qmp_path.with_name("gdb")
    n.args += ["-gdb", f"unix:{n.gdb_path},server=on,wait=off"]
    # GDB is unavailable with the qtest accelerator. Retain the qtest socket
    # for paused diagnostics, but use TCG for every real GDB case.
    n.args[n.args.index("-accel") + 1] = "tcg"
    root = ROOT / "out/gwemu-rdp"
    root.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="run-", dir=root))
    n.stderr_path = evidence / "native.log"
    manifest = json.loads((GWEMU.parent / "gnw-build-manifest.json").read_text())
    digest = hashlib.sha256(GWEMU.read_bytes()).hexdigest()
    assert not manifest["sourceDirty"] and digest == manifest["artifact"]["sha256"]
    report = {"args": n.args, "binarySha256": digest, "revision": manifest["revision"],
              "before": hashes(directory), "observations": [], "validation": "pending"}

    def record(**fields):
        report["observations"].append(fields)
        persist()

    def persist():
        pending = evidence / "acceptance.tmp"
        pending.write_text(json.dumps(report, indent=2) + "\n")
        pending.replace(evidence / "acceptance.json")

    persist()
    try:
        with n:
            report["pid"] = n.process.pid
            persist()
            yield n, record
        assert n.process.returncode == 0
        report["validation"] = "passed"
    except BaseException as exc:
        report.update(validation="failed", error=repr(exc))
        raise
    finally:
        report.update(after=hashes(directory), returncode=n.process.poll() if n.process else None)
        if n.process:
            report["pid"] = n.process.pid
        sidecar = directory / "bank1.bin.rdp"
        report["rdpSidecar"] = sidecar.read_bytes().hex() if sidecar.exists() else None
        persist()


def register_rdp(n):
    return [(n.read32(FLASH + offset) >> 8) & 255 for offset in (*CUR, *PRG)]


def unlock_options(n):
    n.write32(FLASH + 8, 0x08192a3b)
    n.write32(FLASH + 8, 0x4c5d6e7f)
    assert not n.read32(FLASH + 0x18) & 1
    assert not n.read32(FLASH + 0x118) & 1


def commit_rdp(n, value):
    unlock_options(n)
    n.write32(FLASH + 0x20, (n.read32(FLASH + 0x20) & ~0xff00) | (value << 8))
    n.write32(FLASH + 0x18, 2)


def images(n):
    return [n.internal.read_bytes(), (n.directory / "bank2.bin").read_bytes(), n.external.read_bytes()]


def packet(rsp, record, request):
    response = rsp.packet(request)
    record(request=request, response=response)
    return response


def denied(rsp, record, address, length=4):
    assert packet(rsp, record, f"m{address:x},{length:x}").startswith("E")
    assert packet(rsp, record, f"M{address:x},{length:x}:" + "a5" * length).startswith("E")


def test_option_keys_staging_and_committed_aliases(tmp_path):
    with observed(tmp_path) as (n, record):
        before = images(n)
        assert register_rdp(n) == [0xaa] * 4
        for sequence in ((0x4c5d6e7f,), (0x08192a3b, 0, 0x4c5d6e7f)):
            for key in sequence:
                n.write32(FLASH + 8, key)
            n.write32(FLASH + 0x20, 0x5500)
            n.write32(FLASH + 0x18, 2)
            assert n.read32(FLASH + 0x18) & 1
            assert register_rdp(n) == [0xaa] * 4
        n.test(f"writeb {FLASH + 8:#x} 0x3b")
        n.write32(FLASH + 8, 0x4c5d6e7f)
        assert n.read32(FLASH + 0x18) & 1
        unlock_options(n)
        n.write32(FLASH + 0x20, 0x5500)
        assert register_rdp(n) == [0xaa, 0xaa, 0x55, 0xaa]
        for offset in CUR:
            n.write32(FLASH + offset, 0)
        assert register_rdp(n)[:2] == [0xaa, 0xaa]
        n.write32(FLASH + 0x18, 2)
        assert register_rdp(n) == [0x55] * 4
        assert images(n) == before
        record(rdp=register_rdp(n), wholeImagesPreserved=True)


@pytest.mark.parametrize("protected", [0x55, 0x11])
def test_gdb_protection_and_regression_erases_both_complete_banks(tmp_path, protected):
    with observed(tmp_path) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        before = images(n)
        commit_rdp(n, protected)
        for base in BANKS:
            for address, length in ((base, 4), (base + SIZE - 4, 4), (base + SIZE - 2, 4)):
                denied(rsp, record, address, length)
        assert images(n) == before
        assert packet(rsp, record, "M20000100,4:78563412") == "OK"
        assert packet(rsp, record, "m20000100,4") == "78563412"
        # The independent OSPI XIP gate starts disabled, even at RDP0.
        n.write32(0x52005000, (3 << 28) | 1)
        assert packet(rsp, record, "m90000100,4") == before[2][0x100:0x104].hex()
        commit_rdp(n, 0xaa)
        assert register_rdp(n) == [0xaa] * 4
        assert images(n) == [b"\xff" * SIZE, b"\xff" * SIZE, before[2]]
        assert n.read32(0x20000100) == 0x12345678
        for base in BANKS:
            assert packet(rsp, record, f"m{base + SIZE - 4:x},4") == "ffffffff"
            assert packet(rsp, record, f"M{base + 0x100:x},4:12345678") == "OK"
            assert packet(rsp, record, f"m{base + 0x100:x},4") == "12345678"
        record(protected=protected, rdp=register_rdp(n), wholeBanksErased=True)


def test_rdp1_guest_cpu_flash_read_continues_while_gdb_is_denied(tmp_path):
    with observed(tmp_path) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        expected = n.read32(0x08000100)
        commit_rdp(n, 0x55)
        denied(rsp, record, 0x08000100)
        n.command("cont")
        deadline = time.monotonic() + 2
        while n.read32(0x20000200) != expected:
            assert time.monotonic() < deadline, "guest failed to read its protected Flash"
            time.sleep(.01)
        n.command("stop")
        record(guestValue=n.read32(0x20000200), expected=expected, rdp=register_rdp(n))
        denied(rsp, record, 0x08000100)


def test_level2_rejects_both_regressions_and_persists(tmp_path):
    with observed(tmp_path) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        before = images(n)
        commit_rdp(n, 0xcc)
        for value in (0x55, 0xaa):
            commit_rdp(n, value)
            assert register_rdp(n)[:2] == [0xcc, 0xcc]
            assert all(n.read32(FLASH + offset) & (1 << 30) for offset in CUR)
            assert images(n) == before
            denied(rsp, record, 0x08000100)
            denied(rsp, record, 0x08100100)
        record(rdp=register_rdp(n), optionChangeError=True)
    assert (tmp_path / "bank1.bin.rdp").read_bytes() == b"\xcc"
    with observed(tmp_path) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        assert register_rdp(n) == [0xcc] * 4
        assert images(n) == before
        for base in BANKS:
            denied(rsp, record, base + 0x100)
        record(reopenedRdp=register_rdp(n))


def test_warm_reset_and_exit_reopen_preserve_protection_and_erasure(tmp_path):
    with observed(tmp_path) as (n, record):
        before = images(n)
        commit_rdp(n, 0x55)
        n.command("system_reset")
        n.command("query-status")
        assert register_rdp(n) == [0x55] * 4
        assert images(n) == before
        record(resetRdp=register_rdp(n))
    with observed(tmp_path) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        assert register_rdp(n) == [0x55] * 4
        assert images(n) == before
        denied(rsp, record, 0x08000100)
        commit_rdp(n, 0xaa)
        record(unlockedRdp=register_rdp(n))
    with observed(tmp_path) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        assert register_rdp(n) == [0xaa] * 4
        assert images(n) == [b"\xff" * SIZE, b"\xff" * SIZE, before[2]]
        assert packet(rsp, record, "m08000100,4") == "ffffffff"
        record(reopenedErasure=True)


def test_snapshot_restores_actual_rdp_gate_sidecar_and_full_flash(tmp_path):
    with observed(tmp_path, instant=True) as (n, record), contextlib.closing(DeadlineRsp(n.gdb_path)) as rsp:
        before = images(n)
        unlocked = tmp_path / "unlocked.state"
        protected = tmp_path / "protected.state"
        prop(n, "save-state", unlocked)
        commit_rdp(n, 0x55)
        prop(n, "save-state", protected)
        commit_rdp(n, 0xaa)
        assert images(n)[:2] == [b"\xff" * SIZE] * 2
        prop(n, "load-state", protected)
        assert images(n) == before
        assert register_rdp(n) == [0x55] * 4
        assert (tmp_path / "bank1.bin.rdp").read_bytes() == b"\x55"
        for base in BANKS:
            denied(rsp, record, base + 0x100)
        prop(n, "load-state", unlocked)
        assert images(n) == before
        assert register_rdp(n) == [0xaa] * 4
        assert (tmp_path / "bank1.bin.rdp").read_bytes() == b"\xaa"
        assert packet(rsp, record, "m08000100,4") == before[0][0x100:0x104].hex()
        record(restoredProtectedGate=True, restoredUnprotectedGate=True, wholeImagesRestored=True)
