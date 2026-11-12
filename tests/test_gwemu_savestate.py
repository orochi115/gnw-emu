"""Opt-in native snapshots: real VMState and persistent raw Flash rollback."""
import time
import struct
import hashlib
import shutil
import subprocess
import sys

from test_gwemu_desktop import Native, GWEMU
import pytest

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
ADDRESSES = (0x20000100, 0x08000100, 0x08100100, 0x90000100)
OPT_IN = ",instant-states=on,state-id=12345678-1234-1234-1234-123456789abc"


def prop(native, name, value=None):
    args = {"path": "/machine", "property": name}
    if value is None:
        return native.command("qom-get", args)
    return native.command("qom-set", {**args, "value": str(value)})


def error(native, name, value, expected):
    with pytest.raises(AssertionError, match=expected):
        prop(native, name, value)


def sentinels(native, value):
    for i, address in enumerate(ADDRESSES):
        native.write32(address, value + i)


def values(native):
    return [native.read32(a) for a in ADDRESSES]


def backed(directory, machine="", globals=()):
    directory.mkdir(parents=True, exist_ok=True)
    bank2 = directory / "bank2.bin"
    if not bank2.exists():
        bank2.write_bytes(b"\xff" * (256 * 1024))
    return Native(directory, machine,
                  [f"gnw-h7b0-soc.bank2-image={bank2}", *globals])


def migrate(native, command, path):
    native.command(command, {"channels": [{"channel-type": "main", "addr": {
        "transport": "file", "filename": str(path), "offset": 0}}]})
    deadline = time.monotonic() + 5
    while True:
        result = native.command("query-migrate")
        if result.get("status") in ("completed", "failed"):
            assert result["status"] == "completed", result
            return
        assert time.monotonic() < deadline, result
        time.sleep(.01)


def test_file_migration_rolls_back_all_backed_flash(tmp_path):
    state = tmp_path / "migration.bin"
    with backed(tmp_path / "source") as native:
        for i, address in enumerate(ADDRESSES):
            native.write32(address, 0x12345670 + i)
        migrate(native, "migrate", state)
    target = backed(tmp_path / "target")
    target.args += ["-incoming", "defer"]
    with target as native:
        migrate(native, "migrate-incoming", state)
        assert [native.read32(a) for a in ADDRESSES] == [
            0x12345670 + i for i in range(len(ADDRESSES))]


def test_snapshot_opt_in_and_paused_absolute_path_guards(tmp_path):
    with backed(tmp_path / "disabled") as n:
        assert prop(n, "savestate-support") == "disabled"
        error(n, "save-state", tmp_path / "disabled.state", "disabled")
    with backed(tmp_path / "enabled", OPT_IN) as n:
        assert prop(n, "savestate-support") == ""
        error(n, "save-state", "relative.state", "absolute")
        n.command("cont")
        error(n, "save-state", tmp_path / "running.state", "Pause")
        error(n, "load-state", tmp_path / "running.state", "Pause")


def test_snapshot_restores_memory_flash_same_inode_and_reopen(tmp_path):
    directory = tmp_path / "session"
    state = tmp_path / "snapshot.bin"
    with backed(directory, OPT_IN) as n:
        files = (n.internal, directory / "bank2.bin", n.external)
        inodes = [p.stat().st_ino for p in files]
        sentinels(n, 0x12345670)
        prop(n, "save-state", state)
        sentinels(n, 0x76543210)
        prop(n, "load-state", state)
        assert values(n) == [0x12345670 + i for i in range(4)]
        assert not n.command("query-status")["running"]
        assert [p.stat().st_ino for p in files] == inodes
        for i, path in enumerate(files):
            assert struct.unpack_from("<I", path.read_bytes(), 0x100)[0] == 0x12345671 + i
        # The incoming/yank lifecycle must support repeated loads and saves.
        prop(n, "load-state", state)
        prop(n, "save-state", tmp_path / "again.bin")
    with backed(directory, OPT_IN) as n:
        assert values(n)[1:] == [0x12345671 + i for i in range(3)]
        sentinels(n, 0x98765430)
        prop(n, "load-state", state)
        assert values(n) == [0x12345670 + i for i in range(4)]


@pytest.mark.parametrize("kind", ["legacy", "truncate", "length", "checksum", "identity", "geometry"])
def test_invalid_snapshot_rejected_before_any_mutation(tmp_path, kind):
    state = tmp_path / "state.bin"
    with backed(tmp_path / "session", OPT_IN) as n:
        sentinels(n, 0x11111110)
        prop(n, "save-state", state)
        data = bytearray(state.read_bytes())
        if kind == "legacy":
            data[:8] = b"GNWSTAT1"
        elif kind == "truncate":
            data = data[:20]
        elif kind == "length":
            data += b"extra"
        elif kind == "checksum":
            data[-1] ^= 1
        elif kind == "identity":
            data[16] ^= 1  # compiled source identity digest
        else:
            data[80] ^= 1  # bank1 geometry, before any mutable data
        state.write_bytes(data)
        sentinels(n, 0x22222220)
        before_cpu = n.command("human-monitor-command", {"command-line": "info registers"})
        error(n, "load-state", state, "state|State|snapshot|Snapshot")
        assert values(n) == [0x22222220 + i for i in range(4)]
        assert n.command("human-monitor-command", {"command-line": "info registers"}) == before_cpu
        assert not n.command("query-status")["running"]


@pytest.mark.parametrize("other", [",state-id=other", ",uid", ",clock", ",rtc-base"])
def test_snapshot_configuration_mismatch_is_pre_mutation(tmp_path, other):
    state = tmp_path / "state.bin"
    with backed(tmp_path / "source", OPT_IN) as n:
        prop(n, "save-state", state)
    machine = OPT_IN if other != ",state-id=other" else ",instant-states=on,state-id=other"
    globals = []
    if other == ",uid":
        globals = ["gnw-h7b0-soc.uid=000000000000000000000000"]
    if other == ",clock":
        globals = ["gnw-h7b0-rtc.use-rtc-clock=on"]
    target = backed(tmp_path / "target", machine, globals)
    if other == ",rtc-base":
        target.args += ["-rtc", "base=localtime"]
    with target as n:
        sentinels(n, 0x12345670)
        error(n, "load-state", state, "identity|configuration|Incompatible")
        assert values(n) == [0x12345670 + i for i in range(4)]


def test_snapshot_io_errors_propagate_and_leave_vm_paused(tmp_path):
    with backed(tmp_path / "session", OPT_IN) as n:
        sentinels(n, 0x12345670)
        error(n, "save-state", tmp_path / "missing" / "state.bin", "No such file")
        error(n, "load-state", tmp_path / "missing.bin", "No such file")
        error(n, "save-state", tmp_path, "directory")
        assert values(n) == [0x12345670 + i for i in range(4)]
        assert not n.command("query-status")["running"]


@pytest.mark.parametrize("wiring", ["spi1", "ospi"])
def test_snapshot_refuses_sd_in_both_wirings(tmp_path, wiring):
    n = backed(tmp_path / "session", OPT_IN + ",sd-wiring=" + wiring)
    sd = tmp_path / "sd.img"
    with sd.open("wb") as file:
        file.truncate(64 * 1024 * 1024)
    n.args += ["-drive", f"if=sd,format=raw,file={sd}"]
    with n:
        assert prop(n, "savestate-support") == "sd"
        error(n, "save-state", tmp_path / "state.bin", "sd")


def test_snapshot_refuses_128mib_flash(tmp_path):
    n = backed(tmp_path / "session", OPT_IN)
    i = n.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
    n.args[i] = "gnw-h7b0-soc.extflash-chip=c2-25-3b"
    with n:
        assert prop(n, "savestate-support") == "flash-size"
        error(n, "load-state", tmp_path / "state.bin", "flash-size")


def test_snapshot_refuses_experimental_timing(tmp_path):
    n = backed(tmp_path / "session", OPT_IN, ["gnw-h7b0-soc.timing-mode=on"])
    i = n.args.index("-accel")
    del n.args[i:i + 2]
    n.args += ["-icount", "shift=0"]
    with n:
        assert prop(n, "savestate-support") == "timing"
        error(n, "save-state", tmp_path / "state.bin", "timing")


@pytest.mark.parametrize("device", ["adc", "flash_r", "dma", "dwt", "ospi",
                                    "mdma", "jpeg", "tim1", "tim2", "dma2d"])
def test_snapshot_refuses_independently_enabled_peripheral_timing(tmp_path, device):
    n = backed(tmp_path / "session", OPT_IN,
               [f"gnw-h7b0-{device}.timing-mode=on"])
    if device == "dwt":
        # The DWT cycle counter requires icount even without SoC timing mode.
        i = n.args.index("-accel")
        del n.args[i:i + 2]
        n.args += ["-icount", "shift=0"]
    with n:
        assert prop(n, "savestate-support") == "timing"
        error(n, "save-state", tmp_path / "state.bin", "timing")


def test_snapshot_rolls_back_executing_cpu_registers(tmp_path):
    n = backed(tmp_path / "session", OPT_IN)
    image = bytearray(n.internal.read_bytes())
    image[8:12] = b"\x01\x30\xfd\xe7"  # adds r0,#1; b 0x08000008
    n.internal.write_bytes(image)
    i = n.args.index("-accel")
    del n.args[i:i + 2]
    with n:
        n.command("cont")
        time.sleep(.03)
        n.command("stop")
        saved = n.command("human-monitor-command", {"command-line": "info registers"})
        prop(n, "save-state", tmp_path / "cpu.bin")
        n.command("cont")
        time.sleep(.03)
        n.command("stop")
        assert n.command("human-monitor-command", {"command-line": "info registers"}) != saved
        prop(n, "load-state", tmp_path / "cpu.bin")
        assert n.command("human-monitor-command", {"command-line": "info registers"}) == saved


@pytest.mark.parametrize("host", [False, True])
def test_snapshot_restores_actual_rtc_calendar(tmp_path, host):
    from test_gwemu_rtc import POLICY, EPOCH, calendar, set_calendar
    globals = list(POLICY)
    if not host:
        globals.append(f"gnw-h7b0-rtc.initial-epoch={EPOCH}")
    n = backed(tmp_path / "session", OPT_IN, globals)
    n.args += ["-rtc", "base=localtime" if host else "base=2026-01-31T23:59:59,clock=vm"]
    with n:
        set_calendar(n)
        saved = calendar(n)
        prop(n, "save-state", tmp_path / "rtc.bin")
        if host:
            time.sleep(1.1)
        else:
            n.command("cont")
            n.step(3_000_000_000)
            n.command("stop")
        set_calendar(n, tr=0x234501, dr=0x26C131)
        assert calendar(n) != saved
        prop(n, "load-state", tmp_path / "rtc.bin")
        assert calendar(n) == saved


def test_snapshot_restores_rdp_sidecar_and_reports_sync_failure(tmp_path):
    rdp = tmp_path / "rdp.bin"
    rdp.write_bytes(b"\xaa")
    with backed(tmp_path / "session", OPT_IN, [f"gnw-h7b0-soc.rdp-image={rdp}"]) as n:
        state = tmp_path / "state.bin"
        prop(n, "save-state", state)
        rdp.write_bytes(b"\x55")
        prop(n, "load-state", state)
        assert rdp.read_bytes() == b"\xaa"
        rdp.unlink()
        rdp.mkdir()
        error(n, "load-state", state, "RDP")
        assert not n.command("query-status")["running"]
        rdp.rmdir()
        # Failure cleanup leaves a subsequent recovery load usable.
        prop(n, "load-state", state)
        assert rdp.read_bytes() == b"\xaa"


def test_snapshot_stream_failure_cleans_up_and_allows_recovery(tmp_path):
    with backed(tmp_path / "session", OPT_IN) as n:
        state = tmp_path / "good.bin"
        sentinels(n, 0x12345670)
        prop(n, "save-state", state)
        data = bytearray(state.read_bytes())
        header_size = struct.unpack_from(">I", data, 12)[0]
        data[header_size] ^= 1  # invalid QEMU stream magic, valid envelope checksum
        data[header_size - 32:header_size] = hashlib.sha256(data[header_size:]).digest()
        bad = tmp_path / "bad.bin"
        bad.write_bytes(data)
        error(n, "load-state", bad, "magic|Magic|state")
        assert not n.command("query-status")["running"]
        prop(n, "load-state", state)
        assert values(n) == [0x12345670 + i for i in range(4)]


def test_snapshot_save_permission_failure_preserves_previous_file(tmp_path):
    path = tmp_path / "readonly.bin"
    path.write_bytes(b"previous slot")
    path.chmod(0o400)
    try:
        with backed(tmp_path / "session", OPT_IN) as n:
            error(n, "save-state", path, "Permission denied")
            assert path.read_bytes() == b"previous slot"
            assert not n.command("query-status")["running"]
    finally:
        path.chmod(0o600)


@pytest.mark.skipif(sys.platform not in ("darwin", "linux") or not shutil.which("cc"),
                    reason="requires POSIX compiler for syscall fault injection")
def test_restored_flash_sync_error_is_reported_and_vm_stays_paused(tmp_path, monkeypatch):
    # Inject a genuine msync syscall failure in the isolated child process;
    # production code has no test-only fault switches.
    source = tmp_path / "fail-msync.c"
    library = tmp_path / ("fail-msync.dylib" if sys.platform == "darwin" else "fail-msync.so")
    code = """#include <sys/mman.h>
#include <errno.h>
static int failed_sync(void *addr, size_t size, int flags) {
    errno = EIO;
    return -1;
}
"""
    if sys.platform == "darwin":
        code += """__attribute__((used)) static struct { const void *replacement, *original; }
interpose __attribute__((section("__DATA,__interpose"))) = {
    (const void *)failed_sync, (const void *)msync
};
"""
        flags = ["-dynamiclib"]
        variable = "DYLD_INSERT_LIBRARIES"
    else:
        code += "int msync(void *addr, size_t size, int flags) { return failed_sync(addr, size, flags); }\n"
        flags = ["-shared", "-fPIC"]
        variable = "LD_PRELOAD"
    source.write_text(code)
    subprocess.run(["cc", *flags, "-o", str(library), str(source)], check=True,
                   capture_output=True, timeout=20)
    monkeypatch.setenv(variable, str(library))
    with backed(tmp_path / "session", OPT_IN) as n:
        state = tmp_path / "state.bin"
        sentinels(n, 0x12345670)
        prop(n, "save-state", state)
        sentinels(n, 0x76543210)
        error(n, "load-state", state, "sync restored Flash")
        assert not n.command("query-status")["running"]
        assert values(n) == [0x12345670 + i for i in range(4)]
