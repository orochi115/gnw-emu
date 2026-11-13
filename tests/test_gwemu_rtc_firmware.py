"""Opt-in gwemu RTC acceptance; firmware and SD are always copied."""
import json
import os
import shutil
import time

import pytest

from test_gwemu_desktop import ROOT, Native
from test_gwemu_cold_firmware import keys
from test_gwemu_power_firmware import PROFILES, digest
from test_gwemu_power import cold_cycle
from test_gwemu_rtc import B, POLICY, calendar, set_calendar

pytestmark = pytest.mark.skipif(os.environ.get('GNW_FIRMWARE_RTC_TEST') != '1',
                                reason='copied local ROM acceptance opt-in')


@pytest.mark.parametrize('name', ('mario', 'zelda'))
def test_stock_time_button_and_reopen_keep_rtc(tmp_path, name):
    """Valid NOR settings must not send stock firmware through first boot."""
    profile_path = ROOT / PROFILES[name]
    if not profile_path.exists():
        pytest.skip('local profile missing')
    profile = json.loads(profile_path.read_text())
    sources = [(profile_path.parent / profile[key]).resolve()
               for key in ('internalFlash', 'externalFlash')]
    if not all(path.exists() for path in sources):
        pytest.skip('local firmware missing')
    before = [digest(path) for path in sources]
    evidence = ROOT / 'out/gwemu-rtc/stock-reopen' / name
    evidence.mkdir(parents=True, exist_ok=True)
    observations = []
    try:
        for source, target in zip(sources, ('bank1.bin', 'flash.bin')):
            shutil.copyfile(source, tmp_path / target)
        for launch in range(2):
            globals = POLICY + ['gnw-h7b0-rtc.initial-epoch=1767258000']
            if profile.get('deviceUid'):
                globals.append(f'gnw-h7b0-soc.uid={profile["deviceUid"]}')
            n = Native(tmp_path, globals=globals)
            index = n.args.index('-accel')
            del n.args[index:index + 2]
            chip = 'c2-25-34' if name == 'mario' else 'c2-25-36'
            index = n.args.index('gnw-h7b0-soc.extflash-chip=c2-25-34')
            n.args[index] = 'gnw-h7b0-soc.extflash-chip=' + chip
            n.args += ['-rtc', 'base=2026-01-01T09:00:00,clock=vm']
            n.stderr_path = evidence / f'launch-{launch}.log'
            with n:
                n.command('cont')
                time.sleep(3)
                n.command('stop')
                boot = calendar(n)
                n.command('screendump', {'filename': str(evidence / f'boot-{launch}.ppm')})
                n.command('cont')
                for down in (True, False):
                    n.command('input-send-event', {'events': [{'type': 'key', 'data': {
                        'down': down, 'key': {'type': 'qcode', 'data': 't'}}}]})
                    time.sleep(.5)
                n.command('stop')
                after_time = calendar(n)
                assert boot[0] >> 16 == after_time[0] >> 16 == 9
                assert boot[1] == after_time[1] == 0x268101
                observations.append({'launch': launch, 'boot': boot, 'afterTime': after_time})
        (evidence / 'results.json').write_text(json.dumps(observations, indent=2) + '\n')
    finally:
        assert [digest(path) for path in sources] == before


def wait_for_display(n, screen, retrogo, kernel, after_cold=False):
    if retrogo:
        time.sleep(3 if after_cold else 1)
        if after_cold:
            for down in (True, False):
                n.command('input-send-event', {'events': [{'type': 'key', 'data': {
                    'down': down, 'key': {'type': 'qcode', 'data': 't'}}}]})
                time.sleep(.5)
        keys(n, True)
        time.sleep(1)
        keys(n, False)
    time.sleep(3)
    deadline = time.monotonic() + 20
    expected = b'640 480'
    while True:
        n.command('stop')
        n.command('screendump', {'filename': str(screen)})
        magic, geometry, maximum, pixels = screen.read_bytes().split(b'\n', 3)
        assert (magic, geometry, maximum) == (b'P6', expected, b'255')
        lit = sum(r + g + b > 30 for r, g, b in
                  zip(pixels[::3], pixels[1::3], pixels[2::3]))
        vtor = n.read32(0xe000ed08)
        if lit > len(pixels) // 12 and (not retrogo or vtor == 0x08100000):
            return {'litPixels': lit, 'vtor': vtor, 'geometry': geometry.decode()}
        assert time.monotonic() < deadline, 'no firmware display/bank2 handoff'
        n.command('cont')
        time.sleep(.1)


@pytest.mark.parametrize('name', PROFILES)
def test_firmware_clock_and_post_boot_setting(tmp_path, name):
    kernel = "gwemu"
    profile_path = ROOT / PROFILES[name]
    if not profile_path.exists():
        pytest.skip('local profile missing')
    profile = json.loads(profile_path.read_text())
    sources = {k: (profile_path.parent / profile[k]).resolve()
               for k in ('internalFlash', 'externalFlash', 'bank2Flash', 'sdCard')
               if k in profile}
    before = {k: digest(p) for k, p in sources.items()}
    names = {'internalFlash': 'bank1.bin', 'externalFlash': 'flash.bin',
             'bank2Flash': 'bank2.bin', 'sdCard': 'sdcard.img'}
    evidence = ROOT / 'out/gwemu-rtc/firmware' / kernel / name
    evidence.mkdir(parents=True, exist_ok=True)
    try:
        for k, source in sources.items():
            shutil.copyfile(source, tmp_path / names[k])
        globals = POLICY + ['gnw-h7b0-rtc.initial-epoch=1767258000']
        if 'bank2Flash' in sources:
            globals.append(f'gnw-h7b0-soc.bank2-image={tmp_path / names["bank2Flash"]}')
        if profile.get('deviceUid'):
            globals.append(f'gnw-h7b0-soc.uid={profile["deviceUid"]}')
        n = Native(tmp_path, ',power-model=on,battery=80,usb-power=on,'
                   'battery-life-min=0,charge-time-min=0', globals=globals)
        index = n.args.index('-accel')
        del n.args[index:index + 2]
        chip = {1: 'c2-25-34', 4: 'c2-25-36', 64: 'c2-25-3a'}[
            sources['externalFlash'].stat().st_size // (1024 * 1024)]
        index = n.args.index('gnw-h7b0-soc.extflash-chip=c2-25-34')
        n.args[index] = 'gnw-h7b0-soc.extflash-chip=' + chip
        n.args += ['-rtc', 'base=2026-01-01T09:00:00,clock=vm']
        if 'sdCard' in sources:
            n.args += ['-drive', f'if=sd,format=raw,file={tmp_path / "sdcard.img"}']
        with n:
            n.command('cont')
            display = wait_for_display(n, evidence / 'boot.ppm', 'retrogo' in name, kernel)
            boot = calendar(n)
            assert boot[0] >> 16 == 9, f'{kernel}/{name} changed startup hour: {boot}'
            assert boot[1] == 0x268101
            set_calendar(n, 0x123456, 0x26C228)
            adjusted = calendar(n)
            assert adjusted == (0x123456, 0x26C228)
            n.command('system_reset')
            n.command('query-status')
            warm = calendar(n)
            assert warm == adjusted
            cold_seed = cold_boot = None
            cold_cycle(n)
            cold_seed = calendar(n)
            assert cold_seed == (0x090000, 0x268101)
            n.command('cont')
            wait_for_display(n, evidence / 'cold.ppm', 'retrogo' in name,
                             kernel, after_cold=True)
            cold_boot = calendar(n)
            (evidence / 'cold-calendar.json').write_text(json.dumps({
                'seed': cold_seed, 'boot': cold_boot,
                'seedHex': [hex(v) for v in cold_seed],
                'bootHex': [hex(v) for v in cold_boot],
            }, indent=2) + '\n')
            # Patched OFW actively initializes 12:00 after TAMP loss.
            # Accept its writes; sync-host's old suppression hid this.
            assert cold_boot[0] >> 16 == (0x12 if 'retrogo' in name else 9)
            assert cold_boot[1] == (0x21A101 if 'retrogo' in name else 0x268101)
            (evidence / 'rtc.json').write_text(json.dumps({
                'kernel': kernel, 'name': name, 'boot': boot,
                'adjusted': adjusted, 'warm': warm, 'display': display,
                'coldSeed': cold_seed, 'coldBoot': cold_boot,
                'sourceHashes': before,
            }, indent=2) + '\n')
    finally:
        assert {k: digest(p) for k, p in sources.items()} == before
