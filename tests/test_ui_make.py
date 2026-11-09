"""Make-form checks. No window."""
from pathlib import Path

from harness.ui import new_uid, validate_make


def _fields(tmp: Path, **overrides) -> dict:
    internal = tmp / "bank1.bin"
    external = tmp / "ext.bin"
    internal.write_bytes(b"a")
    external.write_bytes(b"b")
    data = {
        "model": "zelda",
        "internal": str(internal),
        "external": str(external),
        "bank2": "",
        "sdcard": "",
        "uid": "00112233445566778899aabb",
    }
    data.update(overrides)
    return data


def test_uid_is_24_hex():
    uid = new_uid()
    assert len(uid) == 24
    int(uid, 16)


def test_required_images_and_optional_card(tmp_path: Path):
    assert validate_make(_fields(tmp_path)) == []
    missing = _fields(tmp_path, internal="")
    assert any("internal" in item for item in validate_make(missing))
    card = tmp_path / "card.img"
    card.write_bytes(b"sd")
    ok = _fields(tmp_path, sdcard=str(card), **{"sd-wiring": "ospi"})
    assert validate_make(ok) == []
    bad = _fields(tmp_path, sdcard=str(card), **{"sd-wiring": "nope"})
    assert any("sd-wiring" in item for item in validate_make(bad))
