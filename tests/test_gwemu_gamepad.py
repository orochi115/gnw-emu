"""Real QMP-to-GPIO boundary used by the desktop's standard pad mappings."""
import pytest

from test_gwemu_desktop import GWEMU, Native

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
PINS = [
    ("left", 3, 11), ("up", 3, 0), ("right", 3, 15), ("down", 3, 14),
    ("x", 3, 9), ("z", 3, 5), ("ret", 2, 11), ("shift_r", 2, 12),
]


def digital_inputs(n):
    for _, port, pin in PINS:
        base = 0x58020000 + port * 0x400
        n.write32(base, n.read32(base) & ~(3 << (pin * 2)))


def levels(n):
    return {key: bool(n.read32(0x58020010 + port * 0x400) & (1 << pin))
            for key, port, pin in PINS}


def send(n, *transitions):
    n.command("input-send-event", {"events": [
        {"type": "key", "data": {"down": down, "key": {"type": "qcode", "data": key}}}
        for key, down in transitions]})
    n.step()


@pytest.mark.parametrize("key", [p[0] for p in PINS])
def test_standard_pad_qcode_changes_only_its_actual_gpio(tmp_path, key):
    with Native(tmp_path) as n:
        digital_inputs(n)
        n.command("cont")
        assert all(levels(n).values())
        send(n, (key, True))
        assert levels(n) == {p[0]: p[0] != key for p in PINS}
        send(n, (key, False))
        assert all(levels(n).values())


def test_releasing_a_does_not_release_a_held_direction(tmp_path):
    with Native(tmp_path) as n:
        digital_inputs(n)
        n.command("cont")
        send(n, ("x", True), ("left", True))
        assert levels(n) == {p[0]: p[0] not in ("x", "left") for p in PINS}
        send(n, ("x", False))
        assert levels(n) == {p[0]: p[0] != "left" for p in PINS}
        send(n, ("left", False))
        assert all(levels(n).values())
