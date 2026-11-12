"""Required TCG acceptance of host-only release while execution is unsafe."""

import contextlib
import hashlib
import json
import os
import time

import pytest
from test_gwemu_desktop import GWEMU, ROOT, Native

PINS = [("left", 3, 11), ("x", 3, 9), ("p", 0, 0)]


def send(native, down):
    return native.command(
        "input-send-event",
        {
            "events": [
                {"type": "key", "data": {"down": down, "key": {"type": "qcode", "data": key}}}
                for key, _port, _pin in PINS
            ]
        },
    )


def levels(native):
    return [bool(native.read32(0x58020010 + port * 0x400) & (1 << pin)) for _key, port, pin in PINS]


def digital_inputs(native):
    for _key, port, pin in PINS:
        base = 0x58020000 + port * 0x400
        native.write32(base, native.read32(base) & ~(3 << (pin * 2)))


def hmp(native, command):
    return native.command("human-monitor-command", {"command-line": command})


def scene(native):
    return {
        "registers": hmp(native, "info registers"),
        "sram": native.test("read 0x20000100 4096"),
        "itcm": native.test("read 0 4096"),
        "flash": {
            name: hashlib.sha256((native.directory / name).read_bytes()).hexdigest()
            for name in ("bank1.bin", "bank2.bin", "flash.bin")
        },
        "runstate": native.command("query-status"),
    }


@contextlib.contextmanager
def observed(directory, name, *, gdb=False, states=False, environment=None, locked=False):
    assert GWEMU.exists(), "build the session-manager native before required input acceptance"
    directory.mkdir(parents=True, exist_ok=True)
    bank2 = directory / "bank2.bin"
    bank2.write_bytes(bytes(range(256)) * 1024)
    state_options = ",instant-states=on,state-id=12345678-1234-1234-1234-123456789abc" if states else ""
    native = Native(
        directory,
        ",power-model=on,battery-life-min=0,charge-time-min=0" + state_options,
        globals=[f"gnw-h7b0-soc.bank2-image={bank2}"] + (["gnw-h7b0-soc.rdp-locked=on"] if locked else []),
        environment=environment,
    )
    native.args[native.args.index("-accel") + 1] = "tcg"
    if gdb:
        native.gdb_path = native.qmp_path.with_name("gdb")
        native.args += ["-gdb", f"unix:{native.gdb_path},server=on,wait=off"]
    image = bytearray(native.internal.read_bytes())
    # Executing guest increments SRAM; the later release assertions compare
    # actual CPU/RAM state with no GDB or reset side effects.
    image[8:24] = bytes.fromhex("0249086801300860fbe700bf00010020")
    native.internal.write_bytes(image)
    report = {"binarySha256": hashlib.sha256(GWEMU.read_bytes()).hexdigest(), "args": native.args}
    output = ROOT / "out/gwemu-completion/session-input"
    output.mkdir(parents=True, exist_ok=True)
    try:
        with native:
            report["nativePid"] = native.process.pid
            yield native, report
        assert native.process.returncode == 0
        with pytest.raises(ProcessLookupError):
            os.kill(native.process.pid, 0)
        report["validation"] = "passed"
    except BaseException as error:
        report.update(validation="failed", error=repr(error))
        raise
    finally:
        report["nativeExit"] = native.process.poll() if native.process else None
        (output / f"{name}.json").write_text(json.dumps(report, indent=2) + "\n")


def test_paused_host_release_preserves_cpu_memory_and_allows_same_keys_again(tmp_path):
    with observed(tmp_path, "paused") as (native, report):
        digital_inputs(native)
        native.command("cont")
        send(native, True)
        time.sleep(0.03)
        native.command("stop")
        assert levels(native) == [False, False, False]
        assert native.read32(0x20000100) > 0, "guest did not execute TCG loop"
        with pytest.raises(AssertionError, match="VM not running"):
            send(native, False)
        before = scene(native)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 3\r\n"
        assert levels(native) == [True, True, True]
        assert scene(native) == before
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 0\r\n"
        native.command("cont")
        send(native, True)
        assert levels(native) == [False, False, False], "same-key repeat flags survived release"
        send(native, False)
        native.command("stop")
        assert levels(native) == [True, True, True]
        report.update(released=3, standardPausedReleaseRejected=True, scenePreserved=True, repeatedPressObserved=True)


def test_unpowered_release_never_runs_unknown_guest_pc(tmp_path):
    from test_gwemu_rdp import DeadlineRsp

    with observed(tmp_path, "unpowered", gdb=True) as (native, report):
        digital_inputs(native)
        native.command("cont")
        send(native, True)
        native.command("qom-set", {"path": "/machine", "property": "battery-present", "value": False})
        assert not native.command("query-status")["running"]
        assert not native.command("qom-get", {"path": "/machine", "property": "powered"})
        rsp = DeadlineRsp(native.gdb_path)
        try:
            # The existing supply loss cold reset already clears host flags.
            # Put PC into arbitrary RAM without running it; cleanup must not
            # continue/reset this unknown target merely to release keys.
            assert rsp.packet("Pf=00000324") == "OK"
            native.write32(0x24030000, 0xDEADBEEF)
            before = scene(native)
            assert hmp(native, "gnw-release-host-input") == "GNW host input released: 0\r\n"
            assert levels(native) == [True, True, True]
            assert scene(native) == before
            assert rsp.packet("pf") == "00000324"
            assert native.read32(0x24030000) == 0xDEADBEEF
        finally:
            rsp.close()
        assert not native.command("query-status")["running"]
        report.update(released=0, scenePreserved=True, unpowered=True, unknownPc="0x24030000")


def test_release_keeps_nonhost_cold_start_power_edge_and_timer(tmp_path):
    with observed(tmp_path, "cold-power") as (native, report):
        assert "requested" in hmp(native, "gnw-cold-cycle")
        native.command("query-status")
        digital_inputs(native)
        native.command("cont")
        deadline = time.monotonic() + 2
        while levels(native)[2]:
            assert time.monotonic() < deadline, "cold-start automatic POWER never pressed"
            time.sleep(0.005)
        native.command("stop")
        assert not levels(native)[2]
        before = scene(native)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 0\r\n"
        assert not levels(native)[2], "host release cancelled nonhost automatic POWER"
        assert scene(native) == before
        native.command("cont")
        deadline = time.monotonic() + 1
        while not levels(native)[2]:
            assert time.monotonic() < deadline, "automatic POWER release timer was cancelled"
            time.sleep(0.005)
        native.command("stop")
        report.update(released=0, automaticPowerPreserved=True, automaticReleaseObserved=True)


def test_non_gnw_machine_refuses_host_release(tmp_path):
    assert GWEMU.exists(), "build the session-manager native before required input acceptance"
    native = Native(tmp_path)
    native.args[native.args.index("-M") + 1] = "virt"
    native.args[native.args.index("-accel") + 1] = "tcg"
    while "-global" in native.args:
        index = native.args.index("-global")
        del native.args[index : index + 2]
    with native:
        before = native.command("query-status")
        reply = hmp(native, "gnw-release-host-input")
        assert "released:" not in reply
        assert any(message in reply for message in ("unknown command", "requires gnw-h7b0", "not available"))
        assert native.command("query-status") == before
    assert native.process.returncode == 0
    with pytest.raises(ProcessLookupError):
        os.kill(native.process.pid, 0)
    output = ROOT / "out/gwemu-completion/session-input"
    output.mkdir(parents=True, exist_ok=True)
    (output / "non-gnw.json").write_text(
        json.dumps(
            {
                "nativePid": native.process.pid,
                "nativeExit": native.process.returncode,
                "binarySha256": hashlib.sha256(GWEMU.read_bytes()).hexdigest(),
                "reply": reply,
                "runstatePreserved": True,
                "validation": "passed",
            },
            indent=2,
        )
        + "\n"
    )


def test_all_twelve_desktop_keys_release_and_repeat_without_execution(tmp_path):
    keys = ("left", "up", "right", "down", "x", "z", "t", "g", "esc", "p", "ret", "shift_r")
    with observed(tmp_path, "all-keys") as (native, report):
        events = [{"type": "key", "data": {"down": True, "key": {"type": "qcode", "data": key}}} for key in keys]
        for _attempt in range(2):
            native.command("cont")
            native.command("input-send-event", {"events": events})
            native.command("stop")
            before = scene(native)
            assert hmp(native, "gnw-release-host-input") == "GNW host input released: 12\r\n"
            assert scene(native) == before
            assert levels(native) == [True, True, True]
        report.update(released=12, repeatReleased=12, scenePreserved=True)


def power(native, down):
    native.command(
        "input-send-event", {"events": [{"type": "key", "data": {"down": down, "key": {"type": "qcode", "data": "p"}}}]}
    )


def wait_power(native, idle, timeout=2):
    deadline = time.monotonic() + timeout
    while levels(native)[2] != idle:
        assert time.monotonic() < deadline, f"POWER never became idle={idle}"
        time.sleep(0.005)


def automatic_power_overlap(native):
    assert "requested" in hmp(native, "gnw-cold-cycle")
    native.command("query-status")
    digital_inputs(native)
    native.command("cont")
    wait_power(native, False)
    power(native, True)
    native.command("stop")
    assert not levels(native)[2]


@pytest.mark.parametrize("cleanup", ["host-only", "normal-keyup"])
def test_host_power_release_preserves_overlapping_automatic_hold(tmp_path, cleanup):
    with observed(tmp_path, f"overlap-{cleanup}") as (native, report):
        automatic_power_overlap(native)
        before = scene(native)
        if cleanup == "host-only":
            assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
            assert scene(native) == before
        else:
            native.command("cont")
            power(native, False)
            native.command("stop")
        assert not levels(native)[2], "host cleanup prematurely released automatic POWER"
        native.command("cont")
        wait_power(native, True)
        native.command("stop")
        report.update(automaticPowerPreserved=True, automaticReleaseObserved=True, cleanup=cleanup)


def test_automatic_power_release_preserves_overlapping_host_hold(tmp_path):
    with observed(tmp_path, "overlap-auto-first") as (native, report):
        automatic_power_overlap(native)
        native.command("cont")
        time.sleep(0.3)
        native.command("stop")
        assert not levels(native)[2], "automatic timer prematurely released host POWER"
        before = scene(native)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
        assert levels(native)[2]
        assert scene(native) == before
        report.update(hostHoldPreserved=True, finalHostReleaseObserved=True, scenePreserved=True)


def test_snapshot_restores_automatic_hold_without_host_ownership(tmp_path):
    from test_gwemu_savestate import prop

    with observed(tmp_path, "overlap-snapshot", states=True) as (native, report):
        automatic_power_overlap(native)
        state = tmp_path / "overlap.state"
        prop(native, "save-state", state)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
        native.command("cont")
        wait_power(native, True)
        native.command("stop")
        prop(native, "load-state", state)
        assert not levels(native)[2]
        # Host ownership must not migrate, but the guest's automatic source
        # must survive ordinary host down/up followed by host-only cleanup.
        native.command("cont")
        power(native, True)
        power(native, False)
        native.command("stop")
        before = scene(native)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 0\r\n"
        assert not levels(native)[2], "snapshot lost automatic-source ownership"
        assert scene(native) == before
        native.command("cont")
        wait_power(native, True)
        native.command("stop")
        report.update(snapshotAutomaticHoldPreserved=True, hostOwnershipDiscarded=True, timerRestored=True)


def test_cold_reset_clears_both_overlapping_input_sources(tmp_path):
    with observed(tmp_path, "overlap-reset") as (native, report):
        automatic_power_overlap(native)
        assert "requested" in hmp(native, "gnw-cold-cycle")
        native.command("query-status")
        digital_inputs(native)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 0\r\n"
        assert levels(native)[2]
        native.command("cont")
        power(native, True)
        native.command("stop")
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
        assert levels(native)[2], "reset retained stale non-host POWER"
        report.update(resetClearedSources=True, newHostReleaseObserved=True)


def test_reset_pa0_release_timer_does_not_cancel_host_power(tmp_path):
    with observed(tmp_path, "overlap-reset-timer") as (native, report):
        digital_inputs(native)
        native.command("cont")
        power(native, True)
        time.sleep(0.1)
        native.command("stop")
        assert not levels(native)[2], "reset PA0 release timer cancelled host POWER"
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
        assert levels(native)[2]
        report.update(hostHoldPreserved=True, resetTimerObserved=True)


def test_legacy_automatic_input_uses_nonhost_source_aggregation(tmp_path):
    with observed(tmp_path, "overlap-legacy-auto", environment={"GNW_AUTO_INPUT": "0.02:left:0.3"}) as (native, report):
        digital_inputs(native)
        native.command("cont")
        deadline = time.monotonic() + 1
        while levels(native)[0]:
            assert time.monotonic() < deadline, "automatic LEFT never pressed"
            time.sleep(0.005)
        native.command(
            "input-send-event",
            {"events": [{"type": "key", "data": {"down": True, "key": {"type": "qcode", "data": "left"}}}]},
        )
        native.command("stop")
        before = scene(native)
        assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
        assert not levels(native)[0], "host cleanup cancelled GNW_AUTO_INPUT"
        assert scene(native) == before
        native.command("cont")
        deadline = time.monotonic() + 1
        while not levels(native)[0]:
            assert time.monotonic() < deadline, "automatic LEFT never released"
            time.sleep(0.005)
        native.command("stop")
        report.update(legacyAutomaticInputPreserved=True, automaticReleaseObserved=True)


def test_host_cleanup_does_not_retrigger_consumed_automatic_unlock_handoff(tmp_path):
    from test_gwemu_rdp import DeadlineRsp

    with observed(tmp_path, "overlap-handoff", gdb=True, locked=True) as (native, report):
        rsp = DeadlineRsp(native.gdb_path)
        try:
            assert "requested" in hmp(native, "gnw-cold-cycle")
            native.command("query-status")
            # A synthetic payload uses the existing verified entry signature,
            # then loops forever. Its only stores target newly allocated SRAM;
            # it does not unlock options or program Flash.
            entry = bytes.fromhex("72b61248002101601149816111480021fee7")
            for offset in range(0, len(entry), 4):
                native.write32(0x4A0 + offset, int.from_bytes(entry[offset : offset + 4].ljust(4, b"\0"), "little"))
            native.write32(0x4EC, 0x20000400)
            native.write32(0x4F0, 0x12345678)
            native.write32(0x4F4, 0x20000420)
            native.command("cont")
            time.sleep(0.8)  # Inside the actual 750..950ms automatic POWER hold.
            native.command("stop")
            assert native.read32(0x20000418) == 0x12345678, "synthetic handoff did not execute"
            native.command("cont")
            power(native, True)
            native.command("stop")
            before = scene(native)
            assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
            assert scene(native) == before
            assert rsp.packet("P0=efbeadde") == "OK"
            native.command("cont")
            power(native, True)
            native.command("stop")
            assert rsp.packet("p0") == "efbeadde", "host edge retriggered an already-held automatic handoff"
            assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
            native.command("cont")
            time.sleep(0.3)
            native.command("stop")
            assert rsp.packet("P0=efbeadde") == "OK"
            native.command("cont")
            power(native, True)
            time.sleep(0.01)
            native.command("stop")
            assert rsp.packet("p0") == "20040020", "automatic release failed to rearm the real handoff edge"
            assert hmp(native, "gnw-release-host-input") == "GNW host input released: 1\r\n"
            report.update(
                syntheticHandoffObserved=True,
                consumedEdgePreserved=True,
                retriggerPrevented=True,
                automaticReleaseRearmedHandoff=True,
            )
        finally:
            rsp.close()
