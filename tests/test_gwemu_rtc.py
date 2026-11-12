"""RTC desktop policy and upstream-default regression on isolated images."""
from datetime import datetime, timezone
import time

import pytest

from test_gwemu_desktop import Native, GWEMU
from test_gwemu_power import cold_cycle, property

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")

B = 0x58004000
EPOCH = int(datetime(2026, 1, 31, 23, 59, 59, tzinfo=timezone.utc).timestamp())
POLICY = ['gnw-h7b0-rtc.use-rtc-clock=on',
          'gnw-h7b0-rtc.preserve-calendar=on', 'gnw-h7b0-rtc.sync-host=off']


def native(path, *, host=False, policy=True, power=False):
    g = list(POLICY) if policy else []
    if not host:
        g.append(f'gnw-h7b0-rtc.initial-epoch={EPOCH}')
    n = Native(path, ',power-model=on,battery-life-min=0,charge-time-min=0'
               if power else '', globals=g)
    n.args += ['-rtc', 'base=localtime' if host else 'base=2026-01-31T23:59:59,clock=vm']
    return n


def calendar(n):
    return n.read32(B), n.read32(B + 4)


def set_calendar(n, tr=0x123456, dr=0x264228):
    n.write32(B + 12, 128)
    n.write32(B, tr)
    n.write32(B + 4, dr)
    n.write32(B + 12, 0)


def test_fixed_rollover_and_shadow(tmp_path):
    with native(tmp_path) as n:
        n.command('cont')
        assert n.read32(B + 8) == 255
        n.step(2_000_000_000)
        # SSR's snapshot keeps the old day until DR unlocks it.
        assert calendar(n) == (0x235959, 0x26C131)
        assert calendar(n) == (0x000001, 0x26E201)
        n.step(500_000_000)
        assert n.read32(B + 8) == 127
        calendar(n)


def test_fixed_pause_freezes(tmp_path):
    with native(tmp_path) as n:
        before = calendar(n)
        time.sleep(.12)
        assert calendar(n) == before
        n.command('cont')
        n.step(1_000_000_000)
        assert calendar(n)[0] == 0


def test_warm_reset_preserves_elapsed_calendar(tmp_path):
    with native(tmp_path) as n:
        n.command('cont'); n.step(2_000_000_000); n.command('stop')
        before = calendar(n)
        n.command('system_reset')
        assert calendar(n) == before


def test_init_freezes_and_commits_pair_once(tmp_path):
    with native(tmp_path) as n:
        n.command('cont')
        n.write32(B + 12, 128)
        assert n.read32(B + 12) & 64
        before = calendar(n)
        n.step(2_000_000_000)
        assert calendar(n) == before
        n.write32(B + 4, 0x262228)  # Feb 28; intermediate Jan 31 must not normalize.
        n.write32(B, 0x123456)
        assert calendar(n) == (0x123456, 0x262228)
        n.write32(B + 12, 0)
        assert not n.read32(B + 12) & 64
        assert calendar(n) == (0x123456, 0x26C228)
        n.step(1_000_000_000)
        assert calendar(n)[0] == 0x123457
        n.command('system_reset')
        assert calendar(n)[0] == 0x123457


@pytest.mark.parametrize('mode', ['cold', 'supply', 'bdrst'])
def test_backup_loss_reseeds_calendar(tmp_path, mode):
    with native(tmp_path, power=True) as n:
        n.command('cont'); set_calendar(n)
        n.command('stop')
        assert calendar(n)[0] == 0x123456
        if mode == 'cold':
            cold_cycle(n)
        elif mode == 'supply':
            property(n, 'battery-present', False)
            property(n, 'battery-present', True)
        else:
            n.write32(0x58024470, 1 << 16)
        assert calendar(n) == (0x235959, 0x26C131)
        n.command('system_reset')
        assert calendar(n) == (0x235959, 0x26C131)


def test_host_ticks_during_pause_and_warm_reset(tmp_path):
    with native(tmp_path, host=True) as n:
        before = calendar(n)
        time.sleep(1.1)
        after = calendar(n)
        assert after != before
        n.command('system_reset')
        current = datetime.now()
        tr = calendar(n)[0]
        assert ((tr >> 16) & 0x3f) == (current.hour // 10 * 16 + current.hour % 10)


def test_host_local_timezone_and_guest_set(tmp_path, monkeypatch):
    monkeypatch.setenv('TZ', 'America/New_York')
    with native(tmp_path, host=True) as n:
        # Guest date is in daylight saving time; mktime must infer DST.
        set_calendar(n, 0x123456, 0x264712)
        assert calendar(n)[0] == 0x123456
        n.command('system_reset')
        assert calendar(n)[0] == 0x123456


@pytest.mark.parametrize('offset,enable,flag', [(0x40, 8, 1), (0x48, 9, 2)])
def test_alarm_and_irq_mask(tmp_path, offset, enable, flag):
    with native(tmp_path) as n:
        n.command('cont')
        # All fields masked except seconds = 01: two seconds after initial date.
        n.write32(B + offset, 0x80808001)
        n.write32(B + 0x18, 1 << enable)
        n.step(2_000_000_000)
        assert n.read32(B + 0x50) & flag
        assert not n.read32(B + 0x54) & flag
        n.write32(B + 0x18, (1 << enable) | (1 << (enable + 4)))
        assert n.read32(B + 0x54) & flag
        n.write32(B + 0x5c, flag)
        assert not n.read32(B + 0x54) & flag


def test_wakeup_timer(tmp_path):
    with native(tmp_path) as n:
        n.command('cont')
        n.write32(B + 0x14, 1)
        n.write32(B + 0x18, (1 << 10) | (1 << 14) | 4)
        n.step(2_000_000_000)
        assert n.read32(B + 0x54) & 4
        n.write32(B + 0x5c, 4)
        assert not n.read32(B + 0x54) & 4
        n.command('system_reset')
        n.step(4_000_000_000)
        assert not n.read32(B + 0x50) & 4


def test_upstream_defaults_are_unchanged(tmp_path):
    with native(tmp_path, policy=False) as n:
        before = calendar(n)
        n.command('cont'); n.step(2_000_000_000)
        assert calendar(n) != before
        n.command('system_reset')
        assert calendar(n) == before
        set_calendar(n)
        assert calendar(n) == before


def test_init_suspends_calendar_alarm_but_not_wakeup(tmp_path):
    with native(tmp_path) as n:
        n.command('cont')
        n.write32(B + 0x40, 0x80808001)
        n.write32(B + 0x14, 1)
        n.write32(B + 0x18, (1 << 8) | (1 << 12) | (1 << 10) | 4)
        n.write32(B + 12, 128)
        n.step(3_000_000_000)
        # Register writes must not re-arm a frozen calendar alarm.
        n.write32(B + 0x40, 0x80808001)
        n.write32(B + 0x18, (1 << 8) | (1 << 12) | (1 << 10) | 4)
        n.step(3_000_000_000)
        assert not n.read32(B + 0x50) & 1
        assert n.read32(B + 0x50) & 4
        n.write32(B + 12, 0)
        n.step(2_000_000_000)
        assert n.read32(B + 0x54) & 1


def test_warm_reset_discards_incomplete_init(tmp_path):
    with native(tmp_path) as n:
        n.command('cont')
        n.write32(B + 12, 128)
        n.write32(B, 0x123456)
        n.step(2_000_000_000)
        n.command('system_reset')
        assert calendar(n) == (1, 0x26E201)


def test_reopen_is_startup_configuration(tmp_path):
    with native(tmp_path) as n:
        set_calendar(n)
        assert calendar(n)[0] == 0x123456
    with native(tmp_path) as n:
        assert calendar(n) == (0x235959, 0x26C131)


def test_host_alarm_and_wakeup_fire_while_paused(tmp_path):
    with native(tmp_path, host=True) as n:
        tr, _ = calendar(n)
        seconds = (tr & 15) + ((tr >> 4) & 7) * 10
        target = (seconds + 2) % 60
        n.write32(B + 0x40, 0x80808000 | (target // 10 << 4) | (target % 10))
        n.write32(B + 0x14, 0)
        n.write32(B + 0x18, (1 << 8) | (1 << 12) | (1 << 10) | (1 << 14) | 4)
        time.sleep(2.1)
        assert n.command('query-status')['status'] == 'prelaunch'
        assert n.read32(B + 0x54) & 5 == 5
        n.command('system_reset')
        time.sleep(1.1)
        assert not n.read32(B + 0x54) & 5


def test_redundant_usb_and_battery_sources_preserve_rtc(tmp_path):
    with native(tmp_path, power=True) as n:
        set_calendar(n)
        expected = calendar(n)
        property(n, 'usb-power', True)
        property(n, 'battery-present', False)
        assert property(n, 'powered') is True
        assert calendar(n) == expected
        property(n, 'battery-present', True)
        property(n, 'usb-power', False)
        assert property(n, 'powered') is True
        assert calendar(n) == expected


def test_existing_sync_host_false_direct_writes(tmp_path):
    with Native(tmp_path, globals=[f'gnw-h7b0-rtc.initial-epoch={EPOCH}',
                                  'gnw-h7b0-rtc.sync-host=off']) as n:
        n.write32(B, 0x123456)
        assert calendar(n)[0] == 0x123456
