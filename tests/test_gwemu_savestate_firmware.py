"""Opt-in full savestate acceptance; mounted firmware is always copied.

The command tests prove this emulator's functional Flash side effects and
rollback. They do not validate physical NOR timing, lock or 1->0 rules.
"""
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import threading
import time

import pytest

from test_gwemu_desktop import ROOT, Native, HEADER, control, receive, display_listener
from test_gwemu_cold_firmware import wait_for_firmware
from test_gwemu_power_firmware import PROFILES, digest
from test_gwemu_power import property
from test_gwemu_rtc import POLICY, calendar
from test_gwemu_savestate import OPT_IN, backed, prop
from test_gwemu_savestate_runtime import snapshot_virtual_clock

pytestmark = pytest.mark.skipif(
    os.environ.get("GNW_FIRMWARE_STATE_TEST") != "1",
    reason="opt in to copied local firmware full savestate acceptance",
)
OSPI = 0x52005000
FLASH = 0x52002000
SCRATCH = 0x38800FF0
SUPPORTED = ("mario", "zelda", "flash-retrogo")


def raw_words(path, offset, size=4):
    with path.open("rb") as stream:
        stream.seek(offset)
        return stream.read(size)


def wren(n):
    n.write32(OSPI, 1)
    n.write32(OSPI + 0x100, 0)
    n.write32(OSPI + 0x110, 6)
    n.write32(OSPI + 0x40, 0)
    n.write32(OSPI + 0x110, 5)
    assert n.read32(OSPI + 0x50) & 2


def nor_command(n, instruction, address, adsize):
    wren(n)
    n.write32(OSPI + 0x100, adsize << 12)
    n.write32(OSPI + 0x110, instruction)
    n.write32(OSPI + 0x48, address)


def program_external(n, address, value, large=False):
    nor_command(n, 0x3E if large else 0x38, address, 3 if large else 2)
    n.write32(OSPI + 0x40, 3)
    n.write32(OSPI + 0x50, value)


def erase_external(n, address, large=False):
    nor_command(n, 0x21 if large else 0x20, address, 3 if large else 2)


def erase_internal(n, index, sector):
    cr = FLASH + (0x0C if index == 1 else 0x10C)
    n.write32(cr, 0)
    n.write32(cr, (sector << 6) | (1 << 2) | (1 << 5))
    assert n.read32(cr) & ((1 << 2) | (1 << 5)) == 0


def program_internal(n, index, address, value):
    # Existing model: PG register shadow plus writable bank mapping. There
    # is no separate physical lock/one-way programming state machine here.
    n.write32(FLASH + (0x0C if index == 1 else 0x10C), 2)
    n.write32(address, value)


class Frames:
    """Observe actual GNWF refresh callbacks with bounded ACK backpressure."""

    def __init__(self, listener):
        self.client = listener.accept()[0]
        self.client.settimeout(3)
        hello = HEADER.unpack(receive(self.client, HEADER.size))
        assert hello[2] == 1
        self.client.sendall(control(2, pixel=1, maximum=16 * 1024 * 1024))
        self.condition = threading.Condition()
        self.latest = None
        self.error = None
        self.closing = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while not self.closing:
                header = HEADER.unpack(receive(self.client, HEADER.size))
                assert header[2] == 3 and 0 < header[4] <= 16 * 1024 * 1024
                pixels = receive(self.client, header[4])
                assert header[4] == header[7] * header[8] * 4
                with self.condition:
                    self.latest = (header, pixels)
                    self.condition.notify_all()
                self.client.sendall(control(4, header[5]))
        except BaseException as error:
            with self.condition:
                if not self.closing:
                    self.error = error
                self.condition.notify_all()

    def wait(self, predicate=lambda _h, _p: True):
        deadline = time.monotonic() + 4
        with self.condition:
            while True:
                if self.error:
                    raise self.error
                if self.latest and predicate(*self.latest):
                    return self.latest
                remaining = deadline - time.monotonic()
                assert remaining > 0, "no fresh matching GNWF callback"
                self.condition.wait(remaining)

    def close(self):
        self.closing = True
        with contextlib.suppress(OSError):
            self.client.shutdown(socket.SHUT_RDWR)
        self.client.close()
        self.thread.join(4)
        assert not self.thread.is_alive(), "orphan frame observer"


def screenshot(n, path):
    n.command("screendump", {"filename": str(path)})
    magic, geometry, maximum, rgb = path.read_bytes().split(b"\n", 3)
    assert (magic, geometry, maximum) == (b"P6", b"640 480", b"255")
    assert sum(r + g + b > 30 for r, g, b in
               zip(rgb[::3], rgb[1::3], rgb[2::3])) > 20000
    rgba = bytearray(len(rgb) // 3 * 4)
    rgba[::4], rgba[1::4], rgba[2::4] = rgb[::3], rgb[1::3], rgb[2::3]
    rgba[3::4] = b"\xff" * (len(rgb) // 3)
    return bytes(rgba)


def power(n):
    return {name: property(n, name) for name in
            ("battery", "battery-present", "usb-power", "powered")}


def cpu(n):
    return n.command("human-monitor-command", {"command-line": "info registers"})


def firmware_machine(directory, profile, endpoint):
    globals = list(POLICY) + ["gnw-h7b0-rtc.initial-epoch=1767258000",
                             f"gnw-h7b0-soc.bank2-image={directory / 'bank2.bin'}"]
    if profile.get("deviceUid"):
        globals.append(f"gnw-h7b0-soc.uid={profile['deviceUid']}")
    n = Native(directory, f",instant-states=on,state-id={profile['id']},"
               f"frame-endpoint=127.0.0.1:{endpoint},power-model=on,battery=80,"
               "usb-power=on,battery-life-min=0,charge-time-min=0", globals)
    index = n.args.index("-accel")
    del n.args[index:index + 2]  # Real TCG, never QTest's private clock.
    size = n.external.stat().st_size // (1024 * 1024)
    chip = {1: "c2-25-34", 4: "c2-25-36", 64: "c2-25-3a"}[size]
    index = n.args.index("gnw-h7b0-soc.extflash-chip=c2-25-34")
    n.args[index] = "gnw-h7b0-soc.extflash-chip=" + chip
    n.args += ["-rtc", "base=2026-01-01T09:00:00,clock=vm"]
    return n


def mutate_flash(n, files):
    for index in (1, 2):
        path = files[f"bank{index}"]
        offset = path.stat().st_size - 8192
        erase_internal(n, index, offset // 8192)
        assert raw_words(path, offset, 8192) == b"\xff" * 8192
        address = (0x08000000 if index == 1 else 0x08100000) + offset
        program_internal(n, index, address, 0x12345670 + index)
        assert raw_words(path, offset) == struct.pack("<I", 0x12345670 + index)
    path = files["external"]
    offset = path.stat().st_size - 4096
    large = path.stat().st_size > 16 * 1024 * 1024
    erase_external(n, offset, large)
    assert raw_words(path, offset, 4096) == b"\xff" * 4096
    program_external(n, offset, 0xDEADBEEF, large)
    assert raw_words(path, offset) == struct.pack("<I", 0xDEADBEEF)


def verify_point(n, files, saved, frames, expected_pixels, evidence, label):
    assert not n.command("query-status")["running"]
    assert cpu(n) == saved["cpu"]
    assert n.read32(SCRATCH) == saved["scratch"]
    assert calendar(n) == tuple(saved["calendar"])
    assert power(n) == saved["power"]
    assert {key: digest(path) for key, path in files.items()} == saved["flash"]
    assert {key: path.stat().st_ino for key, path in files.items()} == saved["inodes"]
    assert screenshot(n, evidence / f"{label}-paused.ppm") == expected_pixels
    previous, _ = frames.wait()
    restored, _ = frames.wait(lambda h, p: h[5] > previous[5] + 1 and p == expected_pixels)
    # Re-save while paused proves the actual global clock rewound exactly.
    prop(n, "save-state", evidence / "clock-proof.bin")
    assert snapshot_virtual_clock(evidence / "clock-proof.bin") == saved["clock"]
    n.command("cont")
    assert n.command("query-status")["running"]
    time.sleep(.2)
    fresh, _ = frames.wait(lambda h, _p: h[5] > restored[5] + 1 and h[6] > restored[6])
    n.command("stop")
    prop(n, "save-state", evidence / "clock-proof.bin")
    advanced = snapshot_virtual_clock(evidence / "clock-proof.bin")
    assert advanced - saved["clock"] > 20_000_000
    assert n.read32(0x50001018) & 1
    assert n.read32(0xE000ED08) == saved["vtor"]
    screenshot(n, evidence / f"{label}-fresh.ppm")
    return {"label": label, "restoredFrame": restored[5], "freshFrame": fresh[5],
            "savedClockNs": saved["clock"], "continuedClockNs": advanced}


@pytest.mark.parametrize("name", SUPPORTED)
def test_real_firmware_repeated_rollback_and_process_reopen(tmp_path, name):
    profile_path = ROOT / PROFILES[name]
    if not profile_path.exists():
        pytest.skip("local profile absent")
    profile = json.loads(profile_path.read_text())
    sources = {key: (profile_path.parent / profile[key]).resolve()
               for key in ("internalFlash", "externalFlash", "bank2Flash") if key in profile}
    if not all(path.exists() for path in sources.values()):
        pytest.skip("local firmware absent")
    before = {key: digest(path) for key, path in sources.items()}
    directory = tmp_path / "session"
    directory.mkdir()
    files = {"bank1": directory / "bank1.bin", "bank2": directory / "bank2.bin",
             "external": directory / "flash.bin"}
    evidence = ROOT / "out/gwemu-savestate/firmware" / name
    evidence.mkdir(parents=True, exist_ok=True)
    state = tmp_path / "saved.bin"
    observations = []
    try:
        for key, target in (("internalFlash", "bank1"), ("externalFlash", "external"),
                            ("bank2Flash", "bank2")):
            if key in sources:
                shutil.copyfile(sources[key], files[target])
        if not files["bank2"].exists():
            files["bank2"].write_bytes(b"\xff" * (256 * 1024))
        with display_listener() as listener:
            with firmware_machine(directory, profile, listener.getsockname()[1]) as n:
                frames = Frames(listener)
                try:
                    n.command("cont")
                    boot = wait_for_firmware(n, evidence / "boot.ppm", name == "flash-retrogo")
                    assert prop(n, "savestate-support") == ""
                    n.write32(SCRATCH, 0x13579BDF)
                    saved_calendar = calendar(n)
                    prop(n, "save-state", state)
                    expected_pixels = screenshot(n, evidence / "saved.ppm")
                    saved = {"cpu": cpu(n), "scratch": n.read32(SCRATCH),
                             "calendar": saved_calendar, "power": power(n),
                             "flash": {key: digest(path) for key, path in files.items()},
                             "flashBytes": {key: path.stat().st_size for key, path in files.items()},
                             "inodes": {key: path.stat().st_ino for key, path in files.items()},
                             "clock": snapshot_virtual_clock(state), "vtor": boot["vtor"]}
                    for cycle in (1, 2):
                        mutate_flash(n, files)
                        assert all(digest(path) != saved["flash"][key]
                                   for key, path in files.items())
                        n.write32(SCRATCH, 0x2468ACE0)
                        property(n, "battery", 30)
                        property(n, "usb-power", False)
                        prop(n, "load-state", state)
                        observations.append(verify_point(n, files, saved, frames, expected_pixels,
                                                         evidence, f"cycle-{cycle}"))
                    # Exit with restored bytes rather than persisting the mutation.
                    prop(n, "load-state", state)
                finally:
                    frames.close()
        assert {key: digest(path) for key, path in files.items()} == saved["flash"]
        with display_listener() as listener:
            with firmware_machine(directory, profile, listener.getsockname()[1]) as n:
                frames = Frames(listener)
                try:
                    mutate_flash(n, files)
                    n.write32(SCRATCH, 0)
                    property(n, "battery", 10)
                    prop(n, "load-state", state)
                    observations.append(verify_point(n, files, saved, frames, expected_pixels,
                                                     evidence, "reopen"))
                    prop(n, "load-state", state)
                finally:
                    frames.close()
        assert {key: digest(path) for key, path in files.items()} == saved["flash"]
        (evidence / "acceptance.json").write_text(json.dumps({
            "profile": name, "boot": boot, "saved": saved, "observations": observations,
            "binary": n.args[0], "binarySha256": digest(Path(n.args[0])),
            "sourceHashes": before, "sourceUnchanged": True,
            "scope": "real TCG full machine/raw Flash rollback and resumed GNWF callbacks; "
                     "fixed RTC policy, functional command models; internal PG+mapped writes "
                     "rather than a physical program engine; no physical NOR timing/lock/1->0 claims",
        }, indent=2) + "\n")
    finally:
        assert {key: digest(path) for key, path in sources.items()} == before
        # Full snapshots are substantial for64MiB; leave compact evidence only.
        (evidence / "clock-proof.bin").unlink(missing_ok=True)


def test_modeled_flash_commands_restore_complete_bytes_and_reopen(tmp_path):
    directory = tmp_path / "session"
    state = tmp_path / "commands.bin"
    with backed(directory, OPT_IN) as n:
        files = {"bank1": n.internal, "bank2": directory / "bank2.bin", "external": n.external}
        # Seed non-erased bytes through the modeled program data path.
        program_internal(n, 1, 0x0803E000, 0x10203040)
        program_internal(n, 2, 0x0813E000, 0x50607080)
        program_external(n, 0xFF000, 0x90ABCDEF)
        expected = {key: path.read_bytes() for key, path in files.items()}
        prop(n, "save-state", state)
        mutate_flash(n, files)
        assert all(path.read_bytes() != expected[key] for key, path in files.items())
        prop(n, "load-state", state)
        assert {key: path.read_bytes() for key, path in files.items()} == expected
    with backed(directory, OPT_IN) as n:
        assert {key: path.read_bytes() for key, path in files.items()} == expected
        mutate_flash(n, files)
        prop(n, "load-state", state)
        assert {key: path.read_bytes() for key, path in files.items()} == expected
