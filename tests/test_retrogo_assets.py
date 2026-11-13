"""Lossless migration of a legacy ROM tree to the common Retro-Go library."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/migrate_retrogo_assets.py"


def migrate(source, output):
    assert SCRIPT.exists(), "the asset migration entry is missing"
    spec = importlib.util.spec_from_file_location("migrate_retrogo_assets", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.migrate_assets(source, output)


def put(root, relative, data):
    file = root / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(data)
    return file


def test_same_stem_cartridges_and_resources_survive(tmp_path):
    source, output = tmp_path / "source", tmp_path / "output"
    put(source, "gb/cart.gb", b"mono cartridge")
    put(source, "gb/cart.gbc", b"color cartridge")
    put(source, "gb/cart.img", b"cover")
    put(source, "gb/cart.ggcodes", b"cheat")
    manifest = migrate(source, output)
    assert (output / "media/roms/gb/cart.gb.gb").read_bytes() == b"mono cartridge"
    assert (output / "media/roms/gbc/cart.gbc.gbc").read_bytes() == b"color cartridge"
    for system, stem in (("gb", "cart.gb"), ("gbc", "cart.gbc")):
        assert (output / f"media/covers/{system}/{stem}.img").read_bytes() == b"cover"
        assert (output / f"media/cheats/{system}/{stem}.ggcodes").read_bytes() == b"cheat"
    assert manifest["rom_count"] == 2


def test_every_source_file_is_preserved_and_verified_by_manifest(tmp_path):
    source, output = tmp_path / "source", tmp_path / "output"
    files = {"nes/game.nes": b"rom", "nes/game.lzma": b"cache",
             "nes/game.img": b"cover", "nes/game.png": b"original art",
             "nes/game.ggcodes": b"cheat", "nes/.keep": b"",
             "msx_bios/MSX2P.rom": b"bios", "msx_bios/msxromdb.xml": b"database"}
    for name, data in files.items():
        put(source, name, data)
    manifest = migrate(source, output)
    assert manifest == json.loads((output / "manifest.json").read_text())
    assert manifest["rom_count"] == 1
    assert len(manifest["files"]) == len(files)
    for entry in manifest["files"]:
        data = files[entry["source"]]
        assert (source / entry["source"]).read_bytes() == data
        assert entry["sha256"] == hashlib.sha256(data).hexdigest()
        assert entry["size"] == len(data)
        assert f"originals/{entry['source']}" in entry["destinations"]
        for name in entry["destinations"]:
            assert (output / name).read_bytes() == data
    assert not (output / "media/roms/nes/game.lzma").exists()
    assert not (output / "media/roms/nes/.keep").exists()
    assert (output / "media/bios/msx/MSX2P.rom").read_bytes() == b"bios"
    assert (output / "media/cheats/nes/game.ggcodes").read_bytes() == b"cheat"
    assert migrate(source, output) == manifest


def test_conflicts_fail_before_copying_other_files(tmp_path):
    source, output = tmp_path / "source", tmp_path / "output"
    put(source, "nes/a.nes", b"A")
    put(source, "nes/b.nes", b"B")
    put(output, "media/roms/nes/b.nes", b"unrelated existing file")
    with pytest.raises(ValueError, match="conflict"):
        migrate(source, output)
    assert not (output / "originals/nes/a.nes").exists()
    assert (output / "media/roms/nes/b.nes").read_bytes() == b"unrelated existing file"


def test_ambiguous_generated_names_are_rejected_without_overwriting(tmp_path):
    source, output = tmp_path / "source", tmp_path / "output"
    for name in ("cart.gb", "cart.gbc", "cart.gb.gb"):
        put(source, "gb/" + name, name.encode())
    with pytest.raises(ValueError, match="collision"):
        migrate(source, output)
    assert not output.exists()


def test_symlinks_and_output_inside_source_are_rejected(tmp_path):
    source = tmp_path / "source"
    target = put(source, "nes/cart.nes", b"rom")
    (source / "linked").symlink_to(target)
    with pytest.raises(ValueError, match="symlink"):
        migrate(source, tmp_path / "out")
    (source / "linked").unlink()
    with pytest.raises(ValueError, match="inside"):
        migrate(source, source / "out")
    put(tmp_path, "escape/nes/cart.nes", b"outside")
    (tmp_path / "out").mkdir()
    (tmp_path / "out/originals").symlink_to(tmp_path / "escape", target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        migrate(source, tmp_path / "out")


def test_changed_source_cannot_replace_completed_library(tmp_path):
    source, output = tmp_path / "source", tmp_path / "output"
    put(source, "nes/cart.nes", b"original rom")
    migrate(source, output)
    put(source, "nes/cart.nes", b"different rom")
    with pytest.raises(ValueError, match="conflict|manifest"):
        migrate(source, output)
    assert (output / "originals/nes/cart.nes").read_bytes() == b"original rom"
