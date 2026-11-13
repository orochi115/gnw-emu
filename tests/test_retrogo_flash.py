"""Flash packaging must preserve OFW and reject layouts before writing."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/build_retrogo_flash.py"


def module():
    assert SCRIPT.exists(), "flash-only builder is required"
    spec = importlib.util.spec_from_file_location("retrogo_flash", SCRIPT)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_explicit_selection_rejects_missing_and_escaping_roms(tmp_path):
    builder = module()
    assets = tmp_path / "media"
    (assets / "roms/nes").mkdir(parents=True)
    (assets / "roms/nes/game.nes").write_bytes(b"game")
    choice = tmp_path / "choice.json"
    choice.write_text(json.dumps({"roms": ["nes/game.nes"]}))
    assert builder.load_selection(choice, assets) == ["nes/game.nes"]
    for names in (["nes/absent.nes"], ["../../choice.json"], [],
                  ["nes/game.nes", "nes/game.nes"]):
        choice.write_text(json.dumps({"roms": names}))
        with pytest.raises(ValueError):
            builder.load_selection(choice, assets)


def test_assembly_preserves_ofw_prefix_and_erased_gaps(tmp_path):
    builder = module()
    ofw = tmp_path / "ofw.bin"
    ofw.write_bytes(b"O" * 8192)
    frog = tmp_path / "frog.bin"
    frog.write_bytes(b"F" * 300)
    little = tmp_path / "little.bin"
    little.write_bytes(b"L" * 4096)
    output = tmp_path / "flash.bin"
    builder.assemble_flash(output, frog, little, 65536, 8192, ofw)
    data = output.read_bytes()
    assert len(data) == 65536
    assert data[:8192] == b"O" * 8192
    assert data[8192:8492] == b"F" * 300
    assert data[8492:-4096] == b"\xff" * (65536 - 8492 - 4096)
    assert data[-4096:] == b"L" * 4096


def test_overflow_and_invalid_layout_leave_destination_absent(tmp_path):
    builder = module()
    frog = tmp_path / "frog.bin"
    frog.write_bytes(b"F" * 12289)
    little = tmp_path / "little.bin"
    little.write_bytes(b"L" * 4096)
    out = tmp_path / "flash.bin"
    with pytest.raises(ValueError, match="overlap"):
        builder.assemble_flash(out, frog, little, 16384, 0)
    assert not out.exists()
    frog.write_bytes(b"F")
    with pytest.raises(ValueError, match="aligned"):
        builder.assemble_flash(out, frog, little, 16384, 1)
    assert not out.exists()
    with pytest.raises(ValueError, match="OFW"):
        builder.assemble_flash(out, frog, little, 16384, 4096)
    assert not out.exists()


def test_existing_image_is_never_overwritten(tmp_path):
    builder = module()
    frog = tmp_path / "frog.bin"
    frog.write_bytes(b"F")
    little = tmp_path / "little.bin"
    little.write_bytes(b"L" * 4096)
    out = tmp_path / "flash.bin"
    out.write_bytes(b"historical")
    with pytest.raises(FileExistsError):
        builder.assemble_flash(out, frog, little, 16384, 0)
    assert out.read_bytes() == b"historical"


def test_profile_has_bank2_only_for_dualboot():
    builder = module()
    standalone = builder.make_profile("zelda", 1)
    assert standalone["internalFlash"] == "bank1.bin"
    assert standalone["externalFlash"] == "extflash.bin"
    assert "bank2Flash" not in standalone and "sdCard" not in standalone
    dual = builder.make_profile("zelda", 2)
    assert dual["bank2Flash"] == "bank2.bin"


def test_partition_size_is_chip_size_minus_ofw_offset():
    builder = module()
    assert builder.flash_layout(64 * 1024 * 1024, 4 * 1024 * 1024) == {
        "partitionSize": 60 * 1024 * 1024,
        "littlefsSize": (60 * 1024 * 1024 // 10 // 4096) * 4096,
        "littlefsOffset": 64 * 1024 * 1024 - (60 * 1024 * 1024 // 10 // 4096) * 4096,
    }


def test_selected_assets_only_and_cheats_are_staged(tmp_path):
    builder = module()
    media = tmp_path / "media"
    for rel, data in (("roms/nes/game.nes", b"rom"),
                      ("roms/nes/other.nes", b"not selected"),
                      ("covers/nes/game.img", b"cover"),
                      ("cheats/nes/game.ggcodes", b"cheat")):
        path = media / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    trial = tmp_path / "trial"
    builder.stage_selected_assets(media, ["nes/game.nes"], trial)
    assert (trial / "roms/nes/game.nes").read_bytes() == b"rom"
    assert not (trial / "roms/nes/other.nes").exists()
    assert (trial / "sd_content/covers/nes/game.img").read_bytes() == b"cover"
    assert (trial / "sd_content/cheats/nes/game.ggcodes").read_bytes() == b"cheat"


def test_cheats_are_readable_in_writable_filesystem(tmp_path):
    builder = module()
    assert hasattr(builder, "pack_littlefs"), "cheats must be packed in the filesystem selected by firmware routing"
    root = SCRIPT.parents[1]
    python = (root / "build/windows-python/Scripts/python.exe" if os.name == "nt"
              else root.parent / ".venv-rgsd/bin/python")
    if not python.exists():
        pytest.skip("Retro-Go build venv is needed for independent LittleFS readback")
    trial = tmp_path / "trial"
    (trial / "sd_content/cores").mkdir(parents=True)
    cheat = trial / "sd_content/cheats/nes/game.ggcodes"
    cheat.parent.mkdir(parents=True)
    cheat.write_bytes(b"AAAAAA: test cheat\n")
    (trial / "build").mkdir()
    import shutil
    shutil.copytree(root / "externals/retro-go-sd/scripts", trial / "scripts")
    with (tmp_path / "log").open("wb") as log:
        builder.pack_littlefs(python, trial, 131072, None, log)
    # The on-flash layout stores LittleFS blocks in reverse order. Decode this
    # independently and read it through the host library, not through staging.
    code = """
from pathlib import Path
from littlefs import LittleFS
from littlefs.context import UserContext
import sys
data=Path(sys.argv[1]).read_bytes()
blocks=[data[i:i+4096] for i in range(0,len(data),4096)]
context=UserContext(len(data))
context.buffer[:]=b''.join(reversed(blocks))
fs=LittleFS(context=context,block_size=4096,block_count=len(blocks),read_size=256,prog_size=256,cache_size=256,lookahead_size=16)
with fs.open('/cheats/nes/game.ggcodes','rb') as file:
 assert file.read()==b'AAAAAA: test cheat\\n'
"""
    subprocess.run([str(python), "-c", code, str(trial / "build/littlefs.bin")], check=True)


def test_mapped_core_paths_are_relative_for_make_on_windows(tmp_path, monkeypatch):
    # Make uses ':' to split MAPPED_BINS, so a Windows drive prefix must not
    # enter this field. Exercise staging rather than merely testing a formatter.
    import sys
    from types import SimpleNamespace
    builder = module()
    monkeypatch.setitem(sys.modules, 'sd_cores_pack', SimpleNamespace(
        core_declared_dirnames=lambda _: {'pce'}))
    package = tmp_path / 'downloads/pce/x/cores'
    package.mkdir(parents=True)
    (package / 'pce.bin').write_bytes(b'core')
    (package / 'pce.xip').write_bytes(b'mapped')
    trial = tmp_path / 'output/source'
    _, mapped = builder.stage_cores(tmp_path / 'downloads', trial, {'pce'}, tmp_path)
    assert mapped == ['mapped/pce.xip:0xDEC00000']
    assert (trial / 'mapped/pce.xip').read_bytes() == b'mapped'
