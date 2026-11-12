"""Complete opt-in snapshots of supply/boot/derived peripheral state."""
import hashlib
import struct
import time

import pytest

from test_gwemu_desktop import GWEMU, configure_audio
from test_gwemu_savestate import OPT_IN, backed, prop, error
from test_gwemu_power import property, convert, cold_cycle, GPIOA, GPIOE, EXTI
from test_gwemu_rtc import B, POLICY, EPOCH, calendar, set_calendar

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
POWER = ',power-model=on,battery=50,usb-power=on,battery-life-min=1,charge-time-min=1'


def save(n, path):
    n.command('stop')
    prop(n, 'save-state', path)


def key(n, name, down):
    n.command('input-send-event', {'events': [{'type': 'key', 'data': {
        'down': down, 'key': {'type': 'qcode', 'data': name}}}]})


def test_supply_fractional_charge_phase_and_guest_state_rewind(tmp_path):
    with backed(tmp_path / 'session', OPT_IN + POWER) as n:
        n.command('cont')
        n.step(1_300_000_000)
        state = tmp_path / 'power.bin'
        save(n, state)
        # 1300ms is 2.1666%, save must retain the subsecond fractional phase.
        n.write32(0x20000100, 0x12345678)
        save(n, state)
        property(n, 'usb-power', False)
        property(n, 'battery', 10)
        property(n, 'battery-present', False)
        assert property(n, 'powered') is False
        prop(n, 'load-state', state)
        assert property(n, 'battery-present') is True
        assert property(n, 'usb-power') is True
        assert property(n, 'powered') is True
        assert n.read32(0x20000100) == 0x12345678
        assert convert(n) == 12043
        assert n.read32(GPIOA) & 4 == 0
        assert n.read32(GPIOE) & 128 == 0
        n.command('cont')
        n.step(690_000_000)
        assert convert(n) == 12043  # tick still waits for saved remaining phase
        n.step(10_000_000)
        assert convert(n) == 12066
        property(n, 'usb-power', False)
        n.step(600_000_000)
        n.command('stop')
        save(n, tmp_path / 'discharge.bin')
        expected = convert(n)
        property(n, 'battery', 99)
        prop(n, 'load-state', tmp_path / 'discharge.bin')
        assert convert(n) == expected


def test_off_snapshot_load_preserves_cpu_ram_and_execution_gate(tmp_path):
    with backed(tmp_path / 'session', OPT_IN + POWER) as n:
        property(n, 'usb-power', False)
        property(n, 'battery-present', False)
        n.write32(0x20000100, 0xdeadbeef)
        saved_cpu = n.command('human-monitor-command', {'command-line': 'info registers'})
        save(n, tmp_path / 'off.bin')
        property(n, 'usb-power', True)
        n.write32(0x20000100, 0)
        prop(n, 'load-state', tmp_path / 'off.bin')
        assert property(n, 'powered') is False
        assert n.read32(0x20000100) == 0xdeadbeef
        assert n.command('human-monitor-command', {'command-line': 'info registers'}) == saved_cpu
        with pytest.raises(AssertionError, match='power supply'):
            n.command('cont')
        assert not n.command('query-status')['running']


def test_pending_cold_power_pulse_retains_remaining_deadline(tmp_path):
    with backed(tmp_path / 'session', OPT_IN + POWER) as n:
        cold_cycle(n)
        n.command('cont')
        n.step(800_000_000)
        assert n.read32(GPIOA) & 1 == 0
        save(n, tmp_path / 'pressed.bin')
        n.command('cont')
        n.step(500_000_000)
        assert n.read32(GPIOA) & 1
        n.command('stop')
        prop(n, 'load-state', tmp_path / 'pressed.bin')
        assert n.read32(GPIOA) & 1 == 0
        n.command('cont')
        n.step(149_000_000)
        assert n.read32(GPIOA) & 1 == 0
        n.step(1_000_000)
        assert n.read32(GPIOA) & 1
        n.step(1_000_000_000)
        assert n.read32(GPIOA) & 1


def test_pending_cold_power_on_is_restored(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        cold_cycle(n)
        n.command('cont')
        n.step(400_000_000)
        save(n, tmp_path / 'before-press.bin')
        n.command('cont')
        n.step(1_000_000_000)
        n.command('stop')
        prop(n, 'load-state', tmp_path / 'before-press.bin')
        n.command('cont')
        n.step(349_000_000)
        assert n.read32(GPIOA) & 1
        n.step(1_000_000)
        assert n.read32(GPIOA) & 1 == 0


def test_completed_pa0_boot_timer_does_not_reappear_on_restore(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.command('cont')
        n.step(60_000_000)
        key(n, 'p', True)
        n.write32(EXTI, 1)
        n.write32(EXTI + 0x88, 1)
        save(n, tmp_path / 'held.bin')
        prop(n, 'load-state', tmp_path / 'held.bin')
        n.command('cont')
        n.step(60_000_000)
        assert n.read32(GPIOA) & 1 == 0
        assert n.read32(EXTI + 0x88) & 1 == 0


def test_host_repeat_bookkeeping_clears_without_releasing_saved_guest_pin(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.command('cont')
        n.step(60_000_000)
        save(n, tmp_path / 'released.bin')
        n.command('cont')
        key(n, 'p', True)
        n.command('stop')
        prop(n, 'load-state', tmp_path / 'released.bin')
        n.command('cont')
        key(n, 'p', True)
        assert n.read32(GPIOA) & 1 == 0
        save(n, tmp_path / 'pressed.bin')
        prop(n, 'load-state', tmp_path / 'pressed.bin')
        assert n.read32(GPIOA) & 1 == 0


@pytest.mark.parametrize('base', [0x5200b800, 0x5200bc00])
def test_otfdec_rebuilds_restored_ciphertext_key_and_window(tmp_path, base):
    region = base + 0x20
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.write32(0x90000100, 0x12345678)
        n.write32(region + 4, 0x90000100)
        n.write32(region + 8, 0x9000013f)
        for i in range(4):
            n.write32(region + 0x14 + i * 4, i + 1)
        n.write32(region, 0x12340001)
        n.write32(0x52005000, (3 << 28) | 1)  # memory-mapped XIP removes OSPI gate
        expected = n.test('read 0x90000100 64')
        assert n.read32(0x90000100) != 0x12345678
        save(n, tmp_path / 'crypto.bin')
        n.write32(region, 0)
        n.write32(0x90000100, 0x87654321)
        n.write32(region + 4, 0x90000200)
        n.write32(region + 8, 0x9000023f)
        n.write32(region + 0x14, 99)
        n.write32(region, 0x56780001)
        prop(n, 'load-state', tmp_path / 'crypto.bin')
        assert n.test('read 0x90000100 64') == expected


@pytest.mark.parametrize('host', [False, True])
def test_rtc_partial_init_and_locked_shadow_restore(tmp_path, host):
    globals = POLICY + ([] if host else [f'gnw-h7b0-rtc.initial-epoch={EPOCH}'])
    n = backed(tmp_path / 'session', OPT_IN, globals)
    n.args += ['-rtc', 'base=localtime' if host else 'base=2026-01-31T23:59:59,clock=vm']
    with n:
        set_calendar(n)
        n.read32(B + 8)  # coherent SSR/TR lock
        save(n, tmp_path / 'shadow.bin')
        calendar(n)
        set_calendar(n, 0x234501)
        prop(n, 'load-state', tmp_path / 'shadow.bin')
        assert calendar(n)[0] == 0x123456
        n.write32(B + 12, 128)
        n.write32(B, 0x090807)
        save(n, tmp_path / 'init.bin')
        n.write32(B + 4, 0x26C131)
        n.write32(B + 12, 0)
        prop(n, 'load-state', tmp_path / 'init.bin')
        assert n.read32(B + 12) & 128
        assert calendar(n) == (0x090807, 0x26C228)
        n.write32(B + 4, 0x26C131)
        n.write32(B + 12, 0)
        assert calendar(n) == (0x090807, 0x26C131)


def test_restored_sai_resumes_output_and_preserves_current_host_mute(tmp_path):
    wav = tmp_path / 'restored.wav'
    n = backed(tmp_path / 'session', OPT_IN)
    i = n.args.index('-audiodev')
    n.args[i + 1] = f'wav,id=snd0,path={wav},out.frequency=48000,out.channels=1'
    with n:
        n.command('cont')
        configure_audio(n)
        n.step(count=30)
        save(n, tmp_path / 'sai.bin')
        acr1 = n.read32(0x40015804)
        n.write32(0x40015804, acr1 & ~(1 << 16))
        n.muted(True)
        prop(n, 'load-state', tmp_path / 'sai.bin')
        assert n.muted() is True
        n.command('cont')
        n.step(count=30)
        muted_begin = wav.stat().st_size
        n.step(count=70)
        muted_end = wav.stat().st_size
        n.muted(False)
        n.step(count=30)
        signal_begin = wav.stat().st_size
        n.step(count=70)
        signal_end = wav.stat().st_size
        assert signal_end - signal_begin > 8000
    data = wav.read_bytes()
    assert not any(data[muted_begin:muted_end])
    assert any(data[signal_begin:signal_end]), 'restored SAI did not reopen its host voice'


def test_partial_hash_message_continues_after_restore(tmp_path):
    base = 0x48021400
    message = b'partially accumulated SHA256 input resumes exactly'
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.write32(base, (1 << 7) | (1 << 18) | (2 << 4) | 4)
        for offset in range(0, 20, 4):
            n.write32(base + 4, int.from_bytes(message[offset:offset + 4], 'little'))
        save(n, tmp_path / 'hash.bin')
        n.write32(base, 4)  # discard accumulated message and change algorithm
        n.write32(base + 4, 0xdeadbeef)
        prop(n, 'load-state', tmp_path / 'hash.bin')
        for offset in range(20, len(message), 4):
            word = message[offset:offset + 4].ljust(4, b'\0')
            n.write32(base + 4, int.from_bytes(word, 'little'))
        n.write32(base + 8, 256 | ((len(message) % 4) * 8))
        digest = b''.join(n.read32(base + 0x310 + i * 4).to_bytes(4, 'big')
                          for i in range(8))
        assert digest == hashlib.sha256(message).digest()
        assert n.read32(base + 0x24) & 2


def test_partial_ospi_program_and_read_continue_at_saved_position(tmp_path):
    base = 0x52005000
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.write32(base + 0x100, 2 << 12)  # Macronix synthetic 24-bit addressing
        n.write32(base + 0x40, 7)
        n.write32(base + 0x110, 0x38)  # configured MX25U8035F quad page program
        n.write32(base + 0x48, 0x100)
        n.write32(base + 0x50, 0x12345678)
        save(n, tmp_path / 'program.bin')
        n.write32(base + 0x50, 0x11111111)
        n.write32(base + 0x110, 0xeb)
        n.write32(base + 0x48, 0x200)
        prop(n, 'load-state', tmp_path / 'program.bin')
        n.write32(base + 0x50, 0x87654321)
        n.write32(base, (3 << 28) | 1)  # expose programmed backing through XIP
        assert n.read32(0x90000100) == 0x12345678
        assert n.read32(0x90000104) == 0x87654321
        n.write32(base + 0x110, 0xeb)
        n.write32(base + 0x48, 0x100)
        assert n.read32(base + 0x50) == 0x12345678
        save(n, tmp_path / 'read.bin')
        assert n.read32(base + 0x50) == 0x87654321
        prop(n, 'load-state', tmp_path / 'read.bin')
        assert n.read32(base + 0x50) == 0x87654321


def test_supply_fraction_deadline_survives_process_restart(tmp_path):
    directory = tmp_path / 'session'
    state = tmp_path / 'power.bin'
    with backed(directory, OPT_IN + POWER) as n:
        n.command('cont')
        n.step(1_300_000_000)
        save(n, state)
        expected = convert(n)
    with backed(directory, OPT_IN + POWER) as n:
        prop(n, 'load-state', state)
        assert convert(n) == expected
        n.command('cont')
        n.step(699_000_000)
        assert convert(n) == expected
        n.step(1_000_000)
        assert convert(n) == 12066


@pytest.mark.parametrize('other', [',power-model=off', ',battery-life-min=2',
                                  ',charge-time-min=2'])
def test_supply_configuration_mismatch_is_rejected_before_mutation(tmp_path, other):
    state = tmp_path / 'power.bin'
    with backed(tmp_path / 'source', OPT_IN + POWER) as n:
        save(n, state)
    with backed(tmp_path / 'target', OPT_IN + POWER + other) as n:
        n.write32(0x20000100, 0xdeadbeef)
        before = n.command('human-monitor-command', {'command-line': 'info registers'})
        error(n, 'load-state', state, 'identity|configuration|Incompatible')
        assert n.read32(0x20000100) == 0xdeadbeef
        assert n.command('human-monitor-command', {'command-line': 'info registers'}) == before


def test_restored_sai_does_not_restart_saved_dma_full_transfer_phase(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        n.command('cont')
        configure_audio(n)
        n.step(13_000_000)  # 10ms half completion; full completion due at 20ms
        assert n.read32(0x40020000) & 0x10
        n.write32(0x40020008, 0x3d)
        save(n, tmp_path / 'phase.bin')
        # Change PLL2 rate to 24kHz, forcing a host voice reconfiguration.
        n.write32(0x58024438, 95 | (39 << 9) | (1 << 16) | (1 << 24))
        n.write32(0x40015804, 0)
        prop(n, 'load-state', tmp_path / 'phase.bin')
        assert n.read32(0x58024438) == (95 | (19 << 9) | (1 << 16) | (1 << 24))
        n.command('cont')
        n.step(6_900_000)
        assert n.read32(0x40020000) & 0x30 == 0
        n.step(100_000)
        assert n.read32(0x40020000) & 0x30 == 0x20


def snapshot_virtual_clock(path):
    # Read the existing wrapper's VMState anchor, sampled from the real
    # QEMU virtual clock. No qtest clock_step is used in the TCG test.
    data = path.read_bytes()
    name = b'gnw-h7b0-snapshot-clock'
    offset = data.index(bytes([len(name)]) + name) + 1 + len(name)
    instance, version, clock = struct.unpack_from('>IIq', data, offset)
    assert instance == 0 and version == 1
    return clock


def test_tcg_global_virtual_clock_rewinds_then_continues(tmp_path):
    n = backed(tmp_path / 'session', OPT_IN)
    i = n.args.index('-accel')
    del n.args[i:i + 2]
    with n:
        n.command('cont')
        time.sleep(.06)
        save(n, tmp_path / 'early.bin')
        early = snapshot_virtual_clock(tmp_path / 'early.bin')
        assert early > 20_000_000
        n.command('cont')
        time.sleep(.10)
        save(n, tmp_path / 'late.bin')
        late = snapshot_virtual_clock(tmp_path / 'late.bin')
        assert late - early > 50_000_000
        prop(n, 'load-state', tmp_path / 'early.bin')
        save(n, tmp_path / 'rewound.bin')
        assert snapshot_virtual_clock(tmp_path / 'rewound.bin') == early
        n.command('cont')
        time.sleep(.06)
        save(n, tmp_path / 'continued.bin')
        assert snapshot_virtual_clock(tmp_path / 'continued.bin') - early > 20_000_000


def test_unlock_handoff_settles_cpu_before_save_and_restores_release_latch(tmp_path):
    rdp = tmp_path / 'rdp.bin'
    rdp.write_bytes(b'\x55')
    with backed(tmp_path / 'session', OPT_IN, [f'gnw-h7b0-soc.rdp-image={rdp}']) as n:
        n.command('cont')
        n.step(60_000_000)
        # Drive PA0 low as guest output, then return to input mode. The
        # handoff consumes POWER without changing this guest pin.
        moder = n.read32(0x58020000)
        n.write32(0x58020000, (moder & ~3) | 1)
        n.write32(0x58020014, n.read32(0x58020014) & ~1)
        n.write32(0x58020000, moder & ~3)
        signature = bytes.fromhex('72b61248002101601149816111480021')
        n.test(f'write 0x4a0 {len(signature)} 0x{signature.hex()}')
        key(n, 'p', True)
        save(n, tmp_path / 'handoff.bin')
        cpu = n.command('human-monitor-command', {'command-line': 'info registers'})
        assert 'R15=000004a0' in cpu
        n.write32(0x4a0, 0xdeadbeef)
        prop(n, 'load-state', tmp_path / 'handoff.bin')
        assert n.command('human-monitor-command', {'command-line': 'info registers'}) == cpu
        assert n.read32(0x4a0) == int.from_bytes(signature[:4], 'little')
        n.command('cont')
        key(n, 'p', True)  # fresh host key state; still suppressed by saved latch
        key(n, 'p', False)
        assert n.read32(GPIOA) & 1 == 0
        n.write32(0x4a0, 0)  # disable synthetic handoff to test next physical press
        key(n, 'p', True)
        key(n, 'p', False)
        assert n.read32(GPIOA) & 1


def test_restored_guest_itcm_does_not_replace_immutable_cold_seed(tmp_path):
    with backed(tmp_path / 'session', OPT_IN) as n:
        initial = n.read32(0x100)
        n.write32(0x100, 0xdeadbeef)
        save(n, tmp_path / 'itcm.bin')
        n.write32(0x100, 0x12345678)
        prop(n, 'load-state', tmp_path / 'itcm.bin')
        assert n.read32(0x100) == 0xdeadbeef
        cold_cycle(n)
        assert n.read32(0x100) == initial


def test_restored_supply_refresh_does_not_create_exti_edges(tmp_path):
    with backed(tmp_path / 'session', OPT_IN + POWER) as n:
        n.write32(0x58000408, 0)  # EXTI2 routes to PA2 (charger-present)
        n.write32(0x5800040c, 4 << 12)  # EXTI7 routes to PE7 (charging)
        n.write32(EXTI, (1 << 2) | (1 << 7))
        n.write32(EXTI + 4, (1 << 2) | (1 << 7))
        n.write32(EXTI + 0x88, (1 << 2) | (1 << 7))
        save(n, tmp_path / 'inputs.bin')
        property(n, 'usb-power', False)
        assert n.read32(EXTI + 0x88) & ((1 << 2) | (1 << 7))
        n.write32(0x58000408, 4 << 8)
        prop(n, 'load-state', tmp_path / 'inputs.bin')
        assert n.read32(EXTI + 0x88) & ((1 << 2) | (1 << 7)) == 0
        assert n.read32(GPIOA) & 4 == 0 and n.read32(GPIOE) & 128 == 0


def test_rtc_ssr_alarm_and_wakeup_saved_remaining_phase(tmp_path):
    n = backed(tmp_path / 'session', OPT_IN, [*POLICY,
               f'gnw-h7b0-rtc.initial-epoch={EPOCH}'])
    n.args += ['-rtc', 'base=2026-01-31T23:59:59,clock=vm']
    with n:
        n.command('cont')
        n.write32(B + 0x40, 0x80808001)
        n.write32(B + 0x14, 1)
        n.write32(B + 0x18, (1 << 8) | (1 << 12) | (1 << 10) | (1 << 14) | 4)
        n.step(700_000_000)
        ssr = n.read32(B + 8)
        calendar(n)  # unlock shadow before saving the fractional live phase
        save(n, tmp_path / 'rtc-phase.bin')
        n.command('cont')
        n.step(3_000_000_000)
        assert n.read32(B + 0x54) & 5 == 5
        n.command('stop')
        prop(n, 'load-state', tmp_path / 'rtc-phase.bin')
        assert n.read32(B + 8) == ssr
        calendar(n)
        assert n.read32(B + 0x54) & 5 == 0
        n.command('cont')
        n.step(1_299_000_000)
        assert n.read32(B + 0x54) & 5 == 0
        n.step(1_000_000)
        assert n.read32(B + 0x54) & 5 == 5


def test_tcg_otfdec_restores_decrypted_instruction_execution(tmp_path):
    region = 0x5200b820
    n = backed(tmp_path / 'session', OPT_IN)
    image = bytearray(n.internal.read_bytes())
    # ldr r0,[pc]; bx r0; .word 0x90000101
    image[8:16] = bytes.fromhex('0048004701010090')
    n.internal.write_bytes(image)
    i = n.args.index('-accel')
    del n.args[i:i + 2]
    with n:
        n.write32(region + 4, 0x90000100)
        n.write32(region + 8, 0x9000010f)
        n.test('write 0x90000100 16 0x' + '00' * 16)
        n.write32(region, 1)
        n.write32(0x52005000, (3 << 28) | 1)
        # AES CTR XOR is symmetric: decrypting zero gives the keystream.
        keystream = bytes.fromhex(n.test('read 0x90000100 16').removeprefix('0x'))

        def program(value):
            # movs r0,#value; ldr r1,[pc,#8]; str r0,[r1]; b start;
            # nop; nop; .word 0x20000100
            plain = bytes([value, 0x20]) + bytes.fromhex('02490860fbe700bf00bf00010020')
            cipher = bytes(a ^ b for a, b in zip(plain, keystream))
            n.write32(region, 0)
            n.test(f'write 0x90000100 16 0x{cipher.hex()}')
            n.write32(region, 1)
            assert bytes.fromhex(n.test('read 0x90000100 16').removeprefix('0x')) == plain

        program(13)
        n.command('cont')
        time.sleep(.03)
        save(n, tmp_path / 'xip.bin')
        assert n.read32(0x20000100) == 13
        program(37)
        n.command('cont')
        time.sleep(.03)
        n.command('stop')
        assert n.read32(0x20000100) == 37
        prop(n, 'load-state', tmp_path / 'xip.bin')
        n.write32(0x20000100, 0)
        n.command('cont')
        time.sleep(.03)
        n.command('stop')
        assert n.read32(0x20000100) == 13


@pytest.mark.parametrize('future_ticks', [1, 2, 3, 10, 30])
def test_restore_drops_audio_queued_after_savepoint(tmp_path, future_ticks):
    wav = tmp_path / 'queue.wav'
    n = backed(tmp_path / 'session', OPT_IN)
    i = n.args.index('-audiodev')
    n.args[i + 1] = f'wav,id=snd0,path={wav},out.frequency=48000,out.channels=1'
    with n:
        n.command('cont')
        configure_audio(n)
        n.step(count=30)
        save(n, tmp_path / 'sai-queue.bin')
        future = struct.pack('<h', -8192) * 960
        n.test(f'write 0x24000000 {len(future)} 0x{future.hex()}')
        n.command('cont')
        n.step(count=future_ticks)
        n.command('stop')
        prop(n, 'load-state', tmp_path / 'sai-queue.bin')
        begin = wav.stat().st_size
        n.command('cont')
        n.step(count=30)
        end = wav.stat().st_size
    # A fresh WAV hardware voice recreates its file; its stdio header may
    # still be buffered at load return. Never interpret the RIFF header as PCM.
    resumed = wav.read_bytes()[max(begin, 44):end]
    assert resumed
    assert min(struct.unpack('<' + 'h' * (len(resumed) // 2), resumed)) >= 0
