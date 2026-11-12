"""Opt-in board charger inputs and retained cold-cycle behavior."""
import subprocess
import time

import pytest

from test_gwemu_desktop import GWEMU, Native

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
ADC = 0x40022000
GPIOA = 0x58020010
GPIOC = 0x58020810
GPIOE = 0x58021010
EXTI = 0x58000000
SYSCFG = 0x58000400


def property(machine, name, value=None):
    args = {"path": "/machine", "property": name}
    if value is None:
        return machine.command("qom-get", args)
    return machine.command("qom-set", {**args, "value": value})


def convert(machine, instance=0, channel=4):
    base = ADC + instance * 0x100
    machine.write32(base + 0x30, channel << 6)
    machine.write32(base + 0x08, 1)
    machine.write32(base + 0x08, 5)
    return machine.read32(base + 0x40)


def test_power_default_retains_upstream_inputs(tmp_path):
    with Native(tmp_path) as machine:
        assert property(machine, "power-model") is False
        assert convert(machine) == 0xffff
        assert machine.read32(GPIOA) & 4 == 0
        assert machine.read32(GPIOC) & (1 << 8)
        with pytest.raises(AssertionError, match="power-model"):
            property(machine, "battery", 50)


@pytest.mark.parametrize("level,raw", [(0, 11000), (50, 12000), (100, 13000)])
def test_power_startup_and_live_adc_both_banks(tmp_path, level, raw):
    with Native(tmp_path, f",power-model=on,battery={level},battery-life-min=0") as machine:
        assert property(machine, "battery") == level
        assert property(machine, "usb-power") is False
        assert machine.read32(GPIOA) & 4
        assert machine.read32(GPIOE) & (1 << 7)
        # PC8 keeps analog/reset readback, but selects the PC5-TIME board
        # when firmware enables digital input. General-purpose output remains.
        assert machine.read32(GPIOC) & (1 << 8)
        moder = machine.read32(GPIOC - 0x10)
        machine.write32(GPIOC - 0x10, moder & ~(3 << 16))
        assert machine.read32(GPIOC) & (1 << 8) == 0
        machine.write32(GPIOC - 0x10, (moder & ~(3 << 16)) | (1 << 16))
        machine.write32(GPIOC + 4, 1 << 8)
        assert machine.read32(GPIOC) & (1 << 8)
        for instance in (0, 1):
            assert convert(machine, instance) == raw
            assert convert(machine, instance, 19) == 0x6000
            assert convert(machine, instance, 3) == 0xffff
        property(machine, "battery", 25)
        assert convert(machine) == 11500
        with pytest.raises(AssertionError, match="0..100"):
            property(machine, "battery", 101)
        assert property(machine, "battery") == 25


def test_usb_charger_edges_and_reset_preserve_external_inputs(tmp_path):
    with Native(tmp_path, ",power-model=on,battery=50,battery-life-min=0,charge-time-min=0") as machine:
        # Route PA2/PE7 to their EXTI lines and arm both edges.
        machine.write32(SYSCFG + 0xc, 4 << 12)
        machine.write32(EXTI, (1 << 2) | (1 << 7))
        machine.write32(EXTI + 4, (1 << 2) | (1 << 7))
        machine.write32(EXTI + 0x88, 0xffffffff)
        property(machine, "usb-power", True)
        assert machine.read32(GPIOA) & 4 == 0
        assert machine.read32(GPIOE) & (1 << 7) == 0
        assert machine.read32(EXTI + 0x88) & ((1 << 2) | (1 << 7)) == (1 << 2) | (1 << 7)
        property(machine, "battery", 100)
        assert machine.read32(GPIOE) & (1 << 7)
        property(machine, "battery", 25)
        machine.command("system_reset")
        # Query-status serializes after the main loop processes reset.
        machine.command("query-status")
        assert property(machine, "battery") == 25
        assert property(machine, "usb-power") is True
        assert convert(machine) == 11500
        assert machine.read32(GPIOA) & 4 == 0
        assert machine.read32(GPIOE) & (1 << 7) == 0
        assert machine.read32(GPIOC) & (1 << 8)
        with pytest.raises(AssertionError, match="initialization"):
            property(machine, "power-model", False)
        with pytest.raises(AssertionError, match="initialization"):
            property(machine, "battery-life-min", 3)


def test_virtual_charge_drain_and_zero_period(tmp_path):
    with Native(tmp_path, ",power-model=on,battery=50,battery-life-min=1,charge-time-min=1") as machine:
        time.sleep(1.1)
        assert property(machine, "battery") == 50
        # QTest does not execute CPU instructions, but cont permits timers.
        machine.command("cont")
        machine.step(6_000_000_000)
        assert property(machine, "battery") == 40
        property(machine, "usb-power", True)
        machine.step(6_000_000_000)
        assert property(machine, "battery") == 50
        machine.step(120_000_000_000)
        assert property(machine, "battery") == 100
        assert machine.read32(GPIOE) & (1 << 7)
        property(machine, "usb-power", False)
        machine.step(120_000_000_000)
        assert property(machine, "battery") == 0
    with Native(tmp_path / "fixed", ",power-model=on,battery=50,battery-life-min=0,charge-time-min=0") as machine:
        machine.command("cont")
        machine.step(120_000_000_000)
        assert property(machine, "battery") == 50
        property(machine, "usb-power", True)
        machine.step(120_000_000_000)
        assert property(machine, "battery") == 50


def test_timing_adc_uses_same_board_channel_without_changing_vref(tmp_path):
    with Native(tmp_path, ",power-model=on,battery=25,battery-life-min=0",
                ["gnw-h7b0-adc.timing-mode=on"]) as machine:
        machine.command("cont")
        machine.write32(ADC + 0x308, 1 << 16)  # synchronous ADC clock

        def timed(instance, channel):
            base = ADC + instance * 0x100
            machine.write32(base + 0x30, channel << 6)
            machine.write32(base + 0x08, 1)
            machine.write32(base + 0x08, 5)
            machine.step(100_000)
            return machine.read32(base + 0x40)

        assert timed(0, 4) == timed(1, 4) == 11500
        property(machine, "battery", 75)
        assert timed(0, 4) == timed(1, 4) == 12500
        assert timed(1, 19) == 0x6000
        assert timed(0, 3) == 0xffff


def test_maximum_period_keeps_rate_without_uint32_overflow(tmp_path):
    with Native(tmp_path, ",power-model=on,battery=50,battery-life-min=4294967295,charge-time-min=4294967295") as machine:
        machine.command("cont")
        machine.step(60_000_000_000)
        assert property(machine, "battery") == 50
        property(machine, "usb-power", True)
        machine.step(60_000_000_000)
        assert property(machine, "battery") == 50


@pytest.mark.parametrize("level", ["101", "-1"])
def test_invalid_startup_level_rejected_before_image_padding(tmp_path, level):
    machine = Native(tmp_path, f",power-model=on,battery={level}")
    try:
        initial = machine.internal.read_bytes()
        result = subprocess.run(machine.args, capture_output=True, timeout=5)
        assert result.returncode != 0
        assert b"battery" in result.stderr
        assert machine.internal.read_bytes() == initial
    finally:
        machine.__exit__()


def test_cold_cycle_clears_ram_retains_flash_uid_and_power_inputs(tmp_path):
    with Native(tmp_path, ",power-model=on,battery=25,usb-power=on,battery-life-min=0,charge-time-min=0",
                ["gnw-h7b0-soc.uid=310047000b51333138343134"]) as machine:
        addresses = [0x20000100, 0x24000100, 0x30000100, 0x30010100, 0x38000100, 0x38800100]
        for address in addresses:
            machine.write32(address, 0x12345678)
        machine.write32(0x08000100, 0x87654321)
        uid = machine.test("read 0x08fff800 12")
        machine.command("human-monitor-command", {"command-line": "gnw-cold-cycle"})
        machine.command("query-status")
        for address in addresses:
            assert machine.read32(address) == 0
        assert machine.read32(0x08000100) == 0x87654321
        assert machine.test("read 0x08fff800 12") == uid
        assert property(machine, "battery") == 25
        assert machine.read32(GPIOA) & 4 == 0
        machine.command("cont")
        machine.step(750_000_000)
        assert machine.read32(GPIOA) & 1 == 0
        machine.step(200_000_000)
        assert machine.read32(GPIOA) & 1


def cold_cycle(machine):
    machine.command("human-monitor-command", {"command-line": "gnw-cold-cycle"})
    machine.command("query-status")


def test_cold_cycle_restores_startup_itcm_not_live_guest_ram(tmp_path):
    seed = tmp_path / "itcm.bin"
    seed.write_bytes(bytes(range(256)))
    machine = Native(tmp_path)
    machine.args += ["-device", f"loader,file={seed},addr=0,force-raw=on"]
    with machine:
        assert machine.read32(0x40) == 0x43424140
        machine.command("cont")
        machine.step(10_000_000)
        machine.command("stop")
        for marker in (0x11223344, 0x55667788):
            machine.write32(0x40, marker)
            machine.write32(0x1000, marker)
            cold_cycle(machine)
            assert machine.read32(0x40) == 0x43424140
            assert machine.read32(0x1000) == 0


def test_cold_cycle_clears_backup_registers_but_warm_reset_retains_them(tmp_path):
    with Native(tmp_path) as machine:
        addresses = (0x58004500, 0x5800457c)
        for address in addresses:
            machine.write32(address, 0x12345678)
        machine.command("system_reset")
        machine.command("query-status")
        assert [machine.read32(address) for address in addresses] == [0x12345678] * 2
        cold_cycle(machine)
        assert [machine.read32(address) for address in addresses] == [0, 0]


def test_repeated_cold_cycle_releases_power_and_reschedules_press(tmp_path):
    with Native(tmp_path) as machine:
        machine.command("cont")
        cold_cycle(machine)
        machine.step(800_000_000)
        assert machine.read32(GPIOA) & 1 == 0
        cold_cycle(machine)
        assert machine.read32(GPIOA) & 1
        machine.step(100_000_000)
        assert machine.read32(GPIOA) & 1
        machine.step(650_000_000)
        assert machine.read32(GPIOA) & 1 == 0
        machine.step(200_000_000)
        assert machine.read32(GPIOA) & 1
