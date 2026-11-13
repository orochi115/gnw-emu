#!/usr/bin/env python3
"""Assemble a Retro-Go SD card image (MBR + FAT32) for gnw-emu.

Content, in this order (later sources win):
  * <retrogo>/sd_content/   fonts, lang, bios/logo.bin, ... from the build
                            (update_bank2.bin is left out: it belongs to
                            the update flow, see --with-update)
  * <dl>/*/x/               unpacked core release zips (cores/, bios/)
  * --roms DIR              an old flash-only Retro-Go roms/ tree: ROMs go
                            to /roms/<sys>/, .img covers (JPEG) to
                            /covers/<sys>/, .ggcodes to /cheats/<sys>/;
                            pre-compressed .lzma copies are skipped
  * --with-update           <retrogo>/release/retro-go_update.bin at the
                            root, for the bootloader update path

The partition table comes from Retro-Go's scripts/make_sdcard_image.py, the
filesystem from mtools (mformat/mcopy), like its gwemu_release target.

  scripts/make_sd_image.py out/sd/sdcard.img --assets local/retrogo-assets/media
"""
import argparse
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_EXT = {".lzma", ".json", ".png", ".jpg", ".xml"}


def copy_tree(src: pathlib.Path, dst: pathlib.Path, skip=()):
    for f in src.rglob("*"):
        rel = f.relative_to(src)
        if f.is_dir() or str(rel) in skip:
            continue
        out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, out)


def stage_roms(roms: pathlib.Path, stage: pathlib.Path, systems):
    counts = {}
    for sysdir in sorted(p for p in roms.iterdir() if p.is_dir()):
        name = sysdir.name.lower()
        if systems and name not in systems:
            continue
        if name.endswith("_bios"):
            continue
        n = 0
        for f in sorted(sysdir.iterdir()):
            ext = f.suffix.lower()
            if not f.is_file() or f.name.startswith('.') or ext in SKIP_EXT:
                continue
            if ext == ".img":
                sub = "covers"
            elif ext == ".ggcodes":
                sub = "cheats"
            else:
                sub = "roms"
                n += 1
            out = stage / sub / name / f.name
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, out)
        counts[name] = n
    return counts


def stage_assets(assets: pathlib.Path, stage: pathlib.Path, systems):
    """Stage a normalized local library, including separated resource trees."""
    counts = stage_roms(assets / "roms", stage, systems)
    for kind in ("covers", "cheats"):
        source = assets / kind
        if source.is_dir():
            for system in source.iterdir():
                if system.is_dir() and (not systems or system.name in systems):
                    copy_tree(system, stage / kind / system.name)
    if (assets / "bios").is_dir():
        copy_tree(assets / "bios", stage / "bios")
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--retrogo", default=str(ROOT / "externals" / "retro-go-sd"))
    ap.add_argument("--dl", default=str(ROOT / "out" / "dl"),
                    help="directory filled by scripts/fetch_cores.sh")
    sources = ap.add_mutually_exclusive_group()
    sources.add_argument("--roms", help="old Retro-Go roms/ tree")
    sources.add_argument("--assets", help="normalized local library media/ tree")
    ap.add_argument("--systems", help="comma separated subset, e.g. nes,gb")
    ap.add_argument("--size-mb", type=int, default=1024)
    ap.add_argument("--with-update", action="store_true")
    args = ap.parse_args()

    rg = pathlib.Path(args.retrogo)
    img = pathlib.Path(args.image)
    stage = img.with_suffix(".stage")
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    copy_tree(rg / "sd_content", stage, skip={"update_bank2.bin"})
    for d in ("roms", "saves", "data", "covers", "cheats"):
        (stage / d).mkdir(exist_ok=True)
    dl = pathlib.Path(args.dl)
    for x in sorted(dl.glob("*/x")):
        copy_tree(x, stage)
    cores = sorted(p.name for p in (stage / "cores").glob("*.bin"))
    print(f"cores: {', '.join(cores) or 'none'}")
    if args.roms or args.assets:
        systems = set(args.systems.split(",")) if args.systems else None
        counts = (stage_assets(pathlib.Path(args.assets), stage, systems)
                  if args.assets else stage_roms(pathlib.Path(args.roms), stage, systems))
        print("roms: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    if args.with_update:
        shutil.copy2(rg / "release" / "retro-go_update.bin", stage)
        print("update: retro-go_update.bin")

    if img.exists():
        img.unlink()
    subprocess.run([sys.executable, str(rg / "scripts" / "make_sdcard_image.py"),
                    str(img), "--size-mb", str(args.size_mb)], check=True)
    part = f"{img}@@1M"
    subprocess.run(["mformat", "-i", part, "-F", "-v", "RETROGO", "::"],
                   check=True)
    entries = [str(p) for p in sorted(stage.iterdir())]
    env = dict(os.environ, MTOOLS_NO_VFAT="0")
    subprocess.run(["mcopy", "-i", part, "-s", "-Q", *entries, "::/"],
                   check=True, env=env)
    shutil.rmtree(stage)
    print(f"{img}: {args.size_mb} MiB FAT32")


if __name__ == "__main__":
    main()
