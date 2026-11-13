#!/usr/bin/env python3
"""Build Flash-only Retro-Go in a fresh directory from an explicit local selection.

No source assets, historical firmware, or existing output are overwritten. This
uses SD_CARD=0's FrogFS/LittleFS layout rather than legacy linked ROM images.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
BLOCK = 4096


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_selection(path, assets):
    data = json.loads(Path(path).read_text())
    names = data.get("roms")
    if not isinstance(names, list) or not names or not all(isinstance(x, str) for x in names):
        raise ValueError("selection requires a non-empty list of ROM path strings")
    if len(set(names)) != len(names):
        raise ValueError("selection requires a non-empty list of unique ROM paths")
    root = (Path(assets) / "roms").resolve()
    for name in names:
        if not isinstance(name, str):
            raise ValueError("selection paths must be strings")
        rel = Path(name)
        source = root / rel
        if rel.is_absolute() or ".." in rel.parts or len(rel.parts) < 2:
            raise ValueError(f"unsafe ROM path: {name}")
        if not source.resolve().is_relative_to(root) or not source.is_file() or source.is_symlink():
            raise ValueError(f"missing or unsafe selected ROM: {name}")
    return names


def flash_layout(chip_size, offset):
    if chip_size <= 0 or chip_size & (chip_size - 1):
        raise ValueError("chip size must be a positive power of two")
    if offset < 0 or offset % BLOCK or offset >= chip_size:
        raise ValueError("EXTFLASH_OFFSET must be aligned and inside the chip")
    partition = chip_size - offset
    little = partition // 10 // BLOCK * BLOCK
    if little < 2 * BLOCK:
        raise ValueError("partition is too small for LittleFS")
    return {"partitionSize": partition, "littlefsSize": little,
            "littlefsOffset": chip_size - little}


def assemble_flash(output, frogfs, littlefs, chip_size, offset, ofw=None):
    output, frogfs, littlefs = map(Path, (output, frogfs, littlefs))
    if output.exists():
        raise FileExistsError(f"refusing to overwrite image: {output}")
    if chip_size <= 0 or chip_size % BLOCK or offset < 0 or offset % BLOCK:
        raise ValueError("chip size and offset must be 4096-aligned")
    little_size = littlefs.stat().st_size
    little_offset = chip_size - little_size
    if not little_size or little_size % BLOCK or little_offset < offset:
        raise ValueError("invalid LittleFS size / overlap")
    if offset + frogfs.stat().st_size > little_offset:
        raise ValueError("FrogFS would overlap LittleFS; select fewer games")
    if offset and (ofw is None or not Path(ofw).is_file() or Path(ofw).stat().st_size < offset):
        raise ValueError("OFW external image must contain the preserved prefix")
    with output.open("xb") as stream:
        chunk = b"\xff" * (1024 * 1024)
        remaining = chip_size
        while remaining:
            count = min(remaining, len(chunk))
            stream.write(chunk[:count])
            remaining -= count
        if offset:
            with Path(ofw).open("rb") as source:
                remaining = offset
                stream.seek(0)
                while remaining:
                    piece = source.read(min(remaining, len(chunk)))
                    if not piece:
                        raise ValueError("OFW source changed while copying its prefix")
                    stream.write(piece)
                    remaining -= len(piece)
        for source_path, start in ((frogfs, offset), (littlefs, little_offset)):
            stream.seek(start)
            with source_path.open("rb") as source:
                shutil.copyfileobj(source, stream)


def make_profile(model, bank):
    result = {"formatVersion": 1, "id": str(uuid.uuid4()), "model": model,
              "internalFlash": "bank1.bin", "externalFlash": "extflash.bin"}
    if bank == 2:
        result["bank2Flash"] = "bank2.bin"
    return result


def copy_regular(src, dst):
    if src.is_symlink() or not src.is_file():
        raise ValueError(f"not a regular asset: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def stage_selected_assets(media, selection, trial):
    media, trial = Path(media), Path(trial)
    for name in selection:
        rel = Path(name)
        copy_regular(media / "roms" / rel, trial / "roms" / rel)
        for directory, suffix in (("covers", ".img"), ("cheats", ".ggcodes")):
            source = media / directory / rel.with_suffix(suffix)
            if source.is_file():
                copy_regular(source, trial / "sd_content" / directory / rel.with_suffix(suffix))
    if (media / "bios").is_dir():
        for source in (media / "bios").rglob("*"):
            if source.is_file():
                copy_regular(source, trial / "sd_content/bios" / source.relative_to(media / "bios"))


def stage_cores(downloads, trial, selected_systems, source):
    """Keep release provenance; mapped sidecars live contiguously in FrogFS."""
    sys.path.insert(0, str(source / "scripts"))
    import sd_cores_pack
    records, mapped, provided = [], [], set()
    for package in sorted(Path(downloads).glob("*/x")):
        cores = package / "cores"
        for file in sorted(cores.glob("*.bin")):
            systems = sd_cores_pack.core_declared_dirnames(file)
            if not systems or not systems.intersection(selected_systems):
                continue
            provided.update(systems)
            for artifact in [file, *sorted(cores.glob(file.stem + ".*"))]:
                if any(record["path"] == str(artifact.resolve()) for record in records):
                    continue
                destination = trial / "sd_content/cores" / artifact.name
                if artifact.suffix == ".xip":
                    if artifact.stem not in ("pce", "gba"):
                        raise ValueError(f"unknown mapped artifact relocation base: {artifact}")
                    destination = trial / "mapped" / artifact.name
                    mapped.append(f"{destination.relative_to(trial).as_posix()}:0xDEC00000")
                copy_regular(artifact, destination)
                records.append({"path": str(artifact.resolve()), "sha256": digest(artifact)})
            bios = package / "bios"
            if bios.is_dir():
                for artifact in bios.rglob("*"):
                    if artifact.is_file():
                        copy_regular(artifact, trial / "sd_content/bios" / artifact.relative_to(bios))
                        records.append({"path": str(artifact.resolve()), "sha256": digest(artifact)})
    missing = selected_systems - provided
    if missing:
        raise ValueError(f"release cores missing for: {', '.join(sorted(missing))}; run scripts/fetch_cores.sh")
    return records, mapped


def git_info(source):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()
    return {"commit": git("rev-parse", "HEAD"), "remote": git("remote", "get-url", "origin"),
            "workingTreeChanges": git("status", "--porcelain")}


def pack_littlefs(python, trial, size, env, log):
    # /cheats falls through to LittleFS in the unmodified firmware syscalls.
    subprocess.run([str(python), "scripts/gen_littlefs_image.py", "--sd-content", "sd_content",
                    "--output", "build/littlefs.bin", "--build-dir", "build/littlefs",
                    "--size", str(size), "--include", "cores", "--include", "lang",
                    "--include", "cheats", "--omit-pico8-ro-from-gnw-zip"],
                   cwd=trial, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)


def build(args):
    output, source, media = args.output.resolve(), args.source.resolve(), args.assets.resolve()
    if output.exists():
        raise FileExistsError(f"use a fresh --output directory: {output}")
    selection = load_selection(args.selection, media)
    chip_size = args.chip_size_mb * 1024 * 1024
    layout = flash_layout(chip_size, args.extflash_offset)
    if args.bank == 2:
        if not args.ofw_bank1 or not args.ofw_extflash or not args.extflash_offset:
            raise ValueError("Bank 2 requires --ofw-bank1, --ofw-extflash and a positive --extflash-offset")
        if not args.ofw_bank1.is_file() or args.ofw_bank1.stat().st_size > 256 * 1024:
            raise ValueError("OFW Bank 1 must exist and fit in 256 KiB")
    elif args.extflash_offset:
        raise ValueError("standalone Bank 1 builds use EXTFLASH_OFFSET=0")
    provenance = git_info(source)
    output.mkdir(parents=True)
    trial = output / "source"
    shutil.copytree(source, trial, ignore=shutil.ignore_patterns(
        ".git", "build", "release", "sd_content", "roms", "__pycache__", "gwemu_bin", "gwemu.app"))
    stage_selected_assets(media, selection, trial)
    core_records, mapped = stage_cores(args.cores, trial, {Path(x).parts[0] for x in selection}, source)
    python = args.python_venv.resolve() / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(python.parent), *([] if os.name == "nt" else ["/opt/homebrew/bin"]), env.get("PATH", "")])
    env["GIT_CEILING_DIRECTORIES"] = str(output)
    make_vars = [f"GCC_PATH={args.gcc_path.resolve().as_posix()}", "CHECK_DIRTY_SUBMODULE=0", "SD_CARD=0",
                 f"GNW_TARGET={args.model}", f"INTFLASH_BANK={args.bank}", "COVERFLOW=1",
                 "DOWNLOAD_COVERS=0", "CHEAT_CODES=1", "COMPRESS=0",
                 f"EXTFLASH_OFFSET={args.extflash_offset}", f"EXTFLASH_SIZE={layout['partitionSize']}",
                 f"FILESYSTEM_SIZE={layout['littlefsSize']}", f"PYTHON3={python.as_posix()}"]
    if mapped:
        make_vars.append("MAPPED_BINS=" + " ".join(mapped))
    with (output / "build.log").open("wb") as log:
        subprocess.run(["make", "-j8", *make_vars, "all", "littlefs_image"], cwd=trial,
                       env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        frog_command = [str(python), "scripts/gen_frogfs_image.py", "--sd-content", "sd_content",
                        "--output", "build/frogfs.bin", "--build-dir", "build/frogfs",
                        "--reserve-size", str(layout["littlefsOffset"] - args.extflash_offset),
                        "--no-gencovers"]
        for directory in ("bios", "covers", "fonts", "roms", "homebrews"):
            frog_command += ["--include", directory]
        for mapped_file in mapped:
            path, base = mapped_file.rsplit(":", 1)
            frog_command += ["--mapped-artifact", f"{path}:{Path(path).name}:{base}"]
        subprocess.run(frog_command, cwd=trial, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        pack_littlefs(python, trial, layout["littlefsSize"], env, log)
    built = trial / "build"
    if (built / "littlefs.bin").stat().st_size != layout["littlefsSize"]:
        raise ValueError("LittleFS image size differs from configured layout")
    firmware = built / "gw_retro_go_intflash.bin"
    if firmware.stat().st_size > 256 * 1024:
        raise ValueError("firmware exceeds internal Bank capacity")
    assemble_flash(output / "extflash.bin", built / "frogfs.bin", built / "littlefs.bin",
                   chip_size, args.extflash_offset, args.ofw_extflash)
    copy_regular(firmware, output / f"bank{args.bank}.bin")
    if args.bank == 2:
        copy_regular(args.ofw_bank1, output / "bank1.bin")
    (output / "retrogo-flash.gnw.json").write_text(json.dumps(make_profile(args.model, args.bank), indent=2) + "\n")
    manifest = {"firmwareSource": provenance, "selection": selection, "layout": layout,
                "makeVariables": make_vars, "coreArtifacts": core_records,
                "selectedAssets": {name: digest(media / "roms" / name) for name in selection},
                "outputs": {p.name: {"bytes": p.stat().st_size, "sha256": digest(p)}
                            for p in output.glob("*.bin")}}
    (output / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return output / "retrogo-flash.gnw.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "local/retrogo-assets/media")
    parser.add_argument("--selection", type=Path, default=ROOT / "profiles/retrogo-flash-selection.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=ROOT / "externals/retro-go-sd")
    parser.add_argument("--cores", type=Path, default=ROOT / "out/dl")
    parser.add_argument("--gcc-path", type=Path, default=Path("/opt/gcc-arm-none-eabi-10.3-2021.10/bin"))
    parser.add_argument("--python-venv", type=Path, default=ROOT.parent / ".venv-rgsd")
    parser.add_argument("--model", choices=("mario", "zelda"), default="zelda")
    parser.add_argument("--bank", type=int, choices=(1, 2), default=1)
    parser.add_argument("--chip-size-mb", type=int, choices=(1, 4, 16, 64), default=64)
    parser.add_argument("--extflash-offset", type=lambda value: int(value, 0), default=0)
    parser.add_argument("--ofw-bank1", type=Path)
    parser.add_argument("--ofw-extflash", type=Path)
    try:
        print(build(parser.parse_args()))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Flash build failed: {error}\n")


if __name__ == "__main__":
    main()
