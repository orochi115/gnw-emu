"""Plain TCG virtual clock acceptance; no instruction-count or qtest time warp."""
import hashlib
import json
import time

import pytest

from test_gwemu_desktop import GWEMU, ROOT
from test_gwemu_savestate import OPT_IN, backed, prop
from test_gwemu_savestate_runtime import save, snapshot_virtual_clock


def assert_active(virtual_ns, wall_seconds):
    assert wall_seconds > 0
    ratio = virtual_ns / 1e9 / wall_seconds
    assert .85 <= ratio <= 1.15, f"virtual/wall clock ratio {ratio}"
    return ratio


def assert_paused(before, after):
    assert before == after, f"paused clock advanced {after - before} ns"


@pytest.mark.parametrize("ratio", [.5, 2])
def test_clock_measurement_rejects_wrong_speed(ratio):
    with pytest.raises(AssertionError, match="ratio"):
        assert_active(int(ratio * 1e9), 1)


def test_clock_measurement_rejects_paused_advance():
    with pytest.raises(AssertionError, match="paused clock advanced"):
        assert_paused(1_000_000_000, 1_350_000_000)


@pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
def test_plain_tcg_clock_pause_and_restore_without_catchup(tmp_path):
    n = backed(tmp_path / "session", OPT_IN)
    i = n.args.index("-accel")
    n.args[i + 1] = "tcg"
    # Guest increments SRAM continuously: ldr r1,[pc,#8]; ldr r0,[r1];
    # adds r0,#1; str r0,[r1]; b loop; nop; .word 0x20000100.
    image = bytearray(n.internal.read_bytes())
    image[8:24] = bytes.fromhex("0249086801300860fbe700bf00010020")
    n.internal.write_bytes(image)
    guest_log = tmp_path / "guest-errors.log"
    n.args += ["-d", "guest_errors", "-D", str(guest_log)]
    evidence = ROOT / "out/gwemu-clock"
    evidence.mkdir(parents=True, exist_ok=True)
    report = {"args": n.args, "binarySha256": hashlib.sha256(GWEMU.read_bytes()).hexdigest(),
              "intervals": [], "completed": False}
    try:
        with n:
            report["pid"] = n.process.pid
            (evidence / "tcg-clock-start.json").write_text(json.dumps(report, indent=2) + "\n")
            assert not n.command("query-status")["running"]
            n.write32(0x20000100, 0)

            def sample(name):
                path = tmp_path / f"{name}.bin"
                save(n, path)
                assert not n.command("query-status")["running"]
                return snapshot_virtual_clock(path), n.read32(0x20000100)

            def active(name, before):
                wall_start = time.monotonic()
                n.command("cont")
                assert n.command("query-status")["running"]
                time.sleep(.4)
                n.command("stop")
                wall = time.monotonic() - wall_start
                after = sample(name)
                ratio = assert_active(after[0] - before[0], wall)
                assert after[1] != before[1], "guest did not execute SRAM loop"
                report["intervals"].append({"name": name, "wallSeconds": wall,
                                            "virtualNs": after[0] - before[0],
                                            "ratio": ratio, "counter": after[1]})
                return after

            initial = sample("initial")
            early = active("early", initial)
            pause_start = time.monotonic()
            time.sleep(.35)
            paused = sample("paused")
            report["pauseWallSeconds"] = time.monotonic() - pause_start
            assert_paused(early[0], paused[0])
            assert paused[1] == early[1], "paused guest executed"
            active("late", paused)
            prop(n, "load-state", tmp_path / "early.bin")
            restored = sample("restored")
            assert restored == early, "clock/RAM did not rewind exactly"
            active("resumed", restored)
            report.update(earlyClockNs=early[0], pausedClockNs=paused[0],
                          restoredClockNs=restored[0], completed=True)
    finally:
        report["returncode"] = n.process.poll() if n.process else None
        report["guestErrors"] = guest_log.read_text() if guest_log.exists() else None
        (evidence / "tcg-clock.json").write_text(json.dumps(report, indent=2) + "\n")
    assert report["returncode"] == 0
    assert report["guestErrors"] == ""
