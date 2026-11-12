"""Native supply truth table and actual TCG/GDB execution-gate regressions."""
import contextlib
import json
import socket
import struct
import subprocess
import time

import pytest

from test_gwemu_desktop import GWEMU, Native
from test_gwemu_power import GPIOA, GPIOE, convert, property
from test_gwemu_softspi import (HardwareSPI, SoftSPI, card_machine,
                               initialize, read_block, write_block)

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
COUNTER = 0x20000100
POWER = ",power-model=on,battery=60,battery-life-min=0,charge-time-min=0"


def running(machine):
    return machine.command("query-status")["running"]


def supply(machine, name, value):
    property(machine, name, value)
    machine.command("query-status")  # Service any pending system reset.


def tcg_counter(directory, extra="", gdb=False):
    machine = Native(directory, POWER + extra)
    # Thumb: ldr r0, literal; [ldr/add/str/b loop]; nop; DTCM counter literal.
    code = struct.pack("<6HI", 0x4802, 0x6801, 0x3101, 0x6001,
                       0xe7fb, 0xbf00, COUNTER)
    image = struct.pack("<II", 0x20010000, 0x08000009) + code
    machine.internal.write_bytes(image + b"\xff" * (128 * 1024 - len(image)))
    index = machine.args.index("-accel")
    del machine.args[index:index + 2]
    if gdb:
        machine.gdb_path = machine.qmp_path.with_name("gdb")
        machine.args += ["-gdb", f"unix:{machine.gdb_path},server=on,wait=off"]
    return machine


def wait_for_counter(machine):
    deadline = time.monotonic() + 3
    while machine.read32(COUNTER) == 0:
        assert time.monotonic() < deadline, "TCG firmware failed to execute"
        time.sleep(.01)


def test_default_presence_and_disabled_model_rejects_runtime_setter(tmp_path):
    with Native(tmp_path) as machine:
        assert property(machine, "battery-present") is True
        assert property(machine, "powered") is True
        with pytest.raises(AssertionError, match="power-model"):
            property(machine, "battery-present", False)
        with pytest.raises(AssertionError):
            property(machine, "powered", False)
        machine.command("cont")
        assert running(machine)


def test_unrelated_machine_without_gate_can_continue(tmp_path):
    machine = Native(tmp_path)
    machine.args = [str(GWEMU), "-M", "none", "-display", "none", "-S",
                    "-qmp", f"unix:{machine.qmp_path},server=on,wait=off",
                    "-qtest", f"unix:{machine.qtest_path},server=on,wait=off",
                    "-qtest-log", "/dev/null"]
    with machine:
        machine.command("cont")
        assert running(machine)


@pytest.mark.parametrize("extra,word", [("battery-present=invalid", "battery-present"),
                                       ("powered=on", "powered")])
def test_invalid_supply_startup_rejected_before_image_padding(tmp_path, extra, word):
    machine = Native(tmp_path, POWER + "," + extra)
    try:
        before = machine.internal.read_bytes()
        result = subprocess.run(machine.args, capture_output=True, timeout=5)
        assert result.returncode != 0
        assert word.encode() in result.stderr
        assert machine.internal.read_bytes() == before
    finally:
        machine.__exit__()


@pytest.mark.parametrize("present,usb", [(True, False), (True, True),
                                          (False, True), (False, False)])
def test_initial_supply_truth_table(tmp_path, present, usb):
    with Native(tmp_path, POWER + f",battery-present={'on' if present else 'off'},"
                f"usb-power={'on' if usb else 'off'}") as machine:
        assert property(machine, "battery-present") is present
        assert property(machine, "powered") is (present or usb)
        if present or usb:
            machine.command("cont")
            assert running(machine)
        else:
            assert machine.read32(0x58004500) == 0
            with pytest.raises(AssertionError, match="supply"):
                machine.command("cont")
            assert not running(machine)


def test_absent_battery_has_no_voltage_or_charging_and_keeps_saved_level(tmp_path):
    with Native(tmp_path, ",power-model=on,battery=60,battery-present=off,"
                "usb-power=on,battery-life-min=1,charge-time-min=1") as machine:
        assert convert(machine) == 0
        assert convert(machine, 1) == 0
        assert machine.read32(GPIOA) & 4 == 0  # USB PGOOD asserted.
        assert machine.read32(GPIOE) & 128  # CHG inactive without a battery.
        machine.command("cont")
        machine.step(120_000_000_000)
        assert property(machine, "battery") == 60
        supply(machine, "battery-present", True)
        machine.step(6_000_000_000)
        assert property(machine, "battery") == 70
        assert convert(machine) == 12400


def test_zero_percent_is_connected_supply_not_removal(tmp_path):
    with Native(tmp_path, POWER + ",battery=0") as machine:
        assert property(machine, "powered") is True
        machine.command("cont")
        assert running(machine)
        supply(machine, "battery-present", False)
        assert property(machine, "powered") is False
        property(machine, "battery", 100)
        assert property(machine, "powered") is False
        assert not running(machine)
        assert convert(machine) == 0


def test_last_source_loss_stops_actual_cpu_and_restore_requires_continue(tmp_path):
    with tcg_counter(tmp_path, ",usb-power=on") as machine:
        original_flash = machine.internal.read_bytes()
        uid = machine.test("read 0x08fff800 12")
        machine.command("cont")
        wait_for_counter(machine)
        # Removing a redundant source must not reset or interrupt execution.
        supply(machine, "battery-present", False)
        assert running(machine)
        assert machine.read32(COUNTER) != 0
        for restore_source in ("usb-power", "battery-present"):
            supply(machine, "usb-power", False)
            assert not running(machine)
            assert property(machine, "powered") is False
            assert machine.read32(COUNTER) == 0
            assert machine.read32(0x58004500) == 0
            with pytest.raises(AssertionError, match="supply"):
                machine.command("cont")
            result = machine.command("human-monitor-command", {"command-line": "cont"})
            assert "supply" in result
            result = machine.command("human-monitor-command", {"command-line": "gnw-cold-cycle"})
            assert "supply" in result
            machine.command("system_reset")
            machine.command("query-status")
            with pytest.raises(AssertionError):
                machine.command("system_wakeup")
            time.sleep(.05)
            assert not running(machine)
            assert machine.read32(COUNTER) == 0
            assert machine.test("read 0x08fff800 12") == uid
            assert machine.internal.read_bytes() == original_flash
            supply(machine, restore_source, True)
            assert property(machine, "powered") is True
            assert not running(machine)
            assert machine.read32(COUNTER) == 0
            machine.command("cont")
            wait_for_counter(machine)
            supply(machine, "battery-present", False)


@pytest.mark.parametrize("autostart", [False, True])
def test_initially_unpowered_tcg_never_executes_until_restore_and_continue(tmp_path, autostart):
    machine = tcg_counter(tmp_path, ",battery-present=off")
    if autostart:
        machine.args.remove("-S")
    with machine:
        with pytest.raises(AssertionError, match="supply"):
            machine.command("cont")
        time.sleep(.05)
        assert machine.read32(COUNTER) == 0
        supply(machine, "usb-power", True)
        assert not running(machine)
        assert machine.read32(COUNTER) == 0
        machine.command("cont")
        wait_for_counter(machine)


def test_back_to_back_restore_and_continue_observes_completed_reset(tmp_path):
    with tcg_counter(tmp_path, ",battery-present=off") as machine:
        # Debug writes while off must not survive the ensuing cold start.
        marker = 0x20000200
        machine.write32(marker, 0x12345678)
        requests = (
            {"execute": "qom-set", "id": "restore", "arguments": {
                "path": "/machine", "property": "usb-power", "value": True}},
            {"execute": "cont", "id": "continue"},
        )
        machine.qmp.sendall(b"".join(json.dumps(request).encode() + b"\n"
                                     for request in requests))
        responses = {}
        while len(responses) < 2:
            response = json.loads(machine.stream.readline())
            if response.get("id") in ("restore", "continue"):
                responses[response["id"]] = response
        assert all("error" not in response for response in responses.values())
        wait_for_counter(machine)
        assert machine.read32(marker) == 0


class Rsp:
    def __init__(self, path):
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.settimeout(2)
        self.socket.connect(str(path))

    def receive(self, size):
        data = bytearray()
        while len(data) < size:
            part = self.socket.recv(size - len(data))
            assert part, "GDB closed"
            data.extend(part)
        return bytes(data)

    def packet(self, payload):
        body = payload.encode()
        self.socket.sendall(b"$" + body + b"#" + f"{sum(body) & 255:02x}".encode())
        while self.receive(1) != b"$":
            pass
        reply = bytearray()
        while True:
            byte = self.receive(1)
            if byte == b"#":
                break
            reply.extend(byte)
        checksum = self.receive(2)
        assert checksum == f"{sum(reply) & 255:02x}".encode()
        self.socket.sendall(b"+")
        return reply.decode()

    def close(self):
        self.socket.close()


def test_gdb_continue_and_single_step_cannot_bypass_supply_gate(tmp_path):
    with tcg_counter(tmp_path, gdb=True) as machine:
        machine.command("cont")
        wait_for_counter(machine)
        supply(machine, "battery-present", False)
        with contextlib.closing(Rsp(machine.gdb_path)) as rsp:
            assert rsp.packet("?").startswith("T")
            for packet in ("c", "s", "C05", "vCont;c", "vCont;s"):
                assert rsp.packet(packet) == "E22"
                assert not running(machine)
                assert machine.read32(COUNTER) == 0
            assert rsp.packet("g")  # Debugger remains usable while off.
            supply(machine, "usb-power", True)
            assert not running(machine)
            machine.command("cont")
            wait_for_counter(machine)
            # A rejected plain step must not leave CPU single-step flags armed.
            time.sleep(.05)
            assert running(machine)


def test_gdb_detach_while_off_has_one_reply_and_does_not_resume(tmp_path):
    with tcg_counter(tmp_path, ",battery-present=off", gdb=True) as machine:
        with contextlib.closing(Rsp(machine.gdb_path)) as rsp:
            assert rsp.packet("?").startswith("T")
            assert rsp.packet("D") == "OK"
            rsp.socket.settimeout(.05)
            with pytest.raises(socket.timeout):
                rsp.socket.recv(1)
            assert not running(machine)
            assert machine.read32(COUNTER) == 0
        with contextlib.closing(Rsp(machine.gdb_path)) as rsp:
            assert rsp.packet("?").startswith("T")
            assert rsp.packet("c") == "E22"


@pytest.mark.parametrize("wiring", ["spi1", "ospi"])
def test_supply_loss_quit_reopen_retains_flash_uid_and_completed_sd_write(tmp_path, wiring):
    bank2 = tmp_path / "bank2.bin"
    bank2.write_bytes(b"\xff" * (256 * 1024))
    uid = "310047000b51333138343134"
    sentinels = {0x08001000: 0x12345678, 0x08101000: 0x87654321,
                 0x90001000: 0x13579bdf}
    block = bytes((i * 37 + 11) & 255 for i in range(512))

    def instance():
        machine = card_machine(tmp_path, wiring)
        machine.args[machine.args.index("-M") + 1] += POWER + ",usb-power=on"
        machine.args += ["-global", f"gnw-h7b0-soc.bank2-image={bank2}",
                         "-global", f"gnw-h7b0-soc.uid={uid}"]
        return machine

    def card(machine):
        spi = SoftSPI(machine) if wiring == "ospi" else HardwareSPI(machine)
        if wiring == "ospi":
            spi.select()
        initialize(spi)
        return spi

    with instance() as machine:
        # Debugger writes to isolated file-backed Flash; no erase/program claim.
        for address, value in sentinels.items():
            machine.write32(address, value)
            assert machine.read32(address) == value
        spi = card(machine)
        write_block(spi, 7, block)
        assert read_block(spi, 7) == block  # Completed write, not interrupted I/O.
        expected_uid = machine.test("read 0x08fff800 12")
        supply(machine, "battery-present", False)
        supply(machine, "usb-power", False)
        assert not running(machine)
        assert property(machine, "powered") is False
    # Reopen mounts the same isolated images with fresh explicit supply inputs.
    with instance() as machine:
        for address, value in sentinels.items():
            assert machine.read32(address) == value
        assert machine.test("read 0x08fff800 12") == expected_uid
        assert read_block(card(machine), 7) == block
