import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sd_assets", Path(__file__).resolve().parents[1] / "scripts/make_sd_image.py")
sd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sd)


def put(root, name, data=b"payload"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_normalized_assets_keep_cover_cheat_and_bios_paths(tmp_path):
    source, stage = tmp_path / "media", tmp_path / "stage"
    files = ["roms/nes/game.nes", "covers/nes/game.img",
             "cheats/nes/game.ggcodes", "bios/msx/db.xml"]
    for name in files:
        put(source, name)
    assert sd.stage_assets(source, stage, None) == {"nes": 1}
    for name in files:
        assert (stage / name).read_bytes() == b"payload"


def test_assets_system_filter_does_not_leak_unselected_roms(tmp_path):
    source, stage = tmp_path / "media", tmp_path / "stage"
    for name in ("roms/nes/game.nes", "roms/gb/game.gb",
                 "covers/gb/game.img", "cheats/gb/game.codes"):
        put(source, name)
    assert sd.stage_assets(source, stage, {"nes"}) == {"nes": 1}
    assert not (stage / "roms/gb/game.gb").exists()
    assert not (stage / "covers/gb/game.img").exists()


def test_legacy_placeholder_is_not_a_rom(tmp_path):
    source, stage = tmp_path / "roms", tmp_path / "stage"
    put(source, "nes/.keep", b"")
    put(source, "nes/game.nes")
    assert sd.stage_roms(source, stage, None) == {"nes": 1}
    assert not (stage / "roms/nes/.keep").exists()
