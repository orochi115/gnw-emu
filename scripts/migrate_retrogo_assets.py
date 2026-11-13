#!/usr/bin/env python3
"""Copy a legacy ROM library without losing originals or replacing existing data.

originals/ preserves every source file. media/ contains ROMs, covers, cheats and
BIOS in the layout shared by Retro-Go's SD and FrogFS builds. manifest.json maps
each source file and its SHA256 to every copied destination.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


ROM_EXTENSIONS = {
    "a2600": {".a26", ".bin"}, "a7800": {".a78"},
    "amstrad": {".dsk", ".cdk"}, "col": {".col"},
    "gb": {".gb", ".gbc"}, "gbc": {".gb", ".gbc"}, "gg": {".gg"},
    "gw": {".gw"}, "md": {".md", ".gen", ".bin"},
    "msx": {".rom", ".mx1", ".mx2", ".dsk", ".cdk"},
    "nes": {".nes", ".fds", ".nsf"}, "pce": {".pce"},
    "sg": {".sg"}, "sms": {".sms"}, "wsv": {".bin", ".sv"},
}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _check_destination(output, destination):
    path = destination
    while path != output.parent:
        if path.is_symlink():
            raise ValueError(f"destination symlink is not allowed: {path}")
        if path == output:
            break
        path = path.parent


def _copy_verified(source, destination, digest):
    if destination.exists():
        if not destination.is_file() or sha256(destination) != digest:
            raise ValueError(f"destination conflict: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".retrogo-copy-", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary)
    try:
        shutil.copy2(source, temporary)
        if sha256(temporary) != digest:
            raise ValueError(f"source changed during migration: {source}")
        try:
            os.link(temporary, destination)  # Publish atomically without replacement.
        except FileExistsError:
            if not destination.is_file() or sha256(destination) != digest:
                raise ValueError(f"destination conflict: {destination}")
    finally:
        temporary.unlink()


def migrate_assets(source, output):
    source, output = Path(source).absolute(), Path(output).absolute()
    if source.is_symlink() or output.is_symlink():
        raise ValueError("source/output root symlink is not allowed")
    source, output = source.resolve(), output.resolve()
    if not source.is_dir():
        raise ValueError(f"source directory does not exist: {source}")
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("source and output must not be inside each other")
    paths = sorted(source.rglob("*"))
    for path in paths:
        if path.is_symlink():
            raise ValueError(f"source symlink is not allowed: {path}")
    files = [path for path in paths if path.is_file()]
    roms = []
    groups = {}
    for path in files:
        relative = path.relative_to(source)
        if len(relative.parts) < 2 or any(part.startswith(".") for part in relative.parts):
            continue
        system = relative.parts[0].lower()
        if path.suffix.lower() not in ROM_EXTENSIONS.get(system, set()):
            continue
        roms.append(path)
        key = (relative.parent.as_posix().casefold(), path.stem.casefold())
        groups.setdefault(key, []).append(path)

    renamed = {}
    target_systems = {}
    for group in groups.values():
        for path in group:
            system = path.relative_to(source).parts[0].lower()
            target_systems[path] = ("gbc" if path.suffix.lower() == ".gbc" else "gb") if system in {"gb", "gbc"} else system
            stem = path.stem
            if len(group) > 1:
                stem += "." + path.suffix.lower().lstrip(".")
            renamed[path] = stem + path.suffix

    entries, planned = [], {}
    for path in files:
        relative = path.relative_to(source)
        destinations = [Path("originals") / relative]
        hidden = any(part.startswith(".") for part in relative.parts)
        if len(relative.parts) >= 2 and not hidden:
            system = relative.parts[0].lower()
            tail = Path(*relative.parts[1:])
            if path in renamed:
                destinations.append(Path("media/roms") / target_systems[path] / tail.with_name(renamed[path]))
            elif path.suffix.lower() in {".img", ".ggcodes"} and system in ROM_EXTENSIONS:
                key = (relative.parent.as_posix().casefold(), path.stem.casefold())
                group = groups.get(key, [])
                targets = [(target_systems[rom], Path(renamed[rom]).stem) for rom in group] or [(system, path.stem)]
                category = "covers" if path.suffix.lower() == ".img" else "cheats"
                for target_system, stem in targets:
                    destinations.append(Path("media") / category / target_system /
                                        tail.with_name(stem + path.suffix.lower()))
            elif system.endswith("_bios"):
                destinations.append(Path("media/bios") / system[:-5] / tail)
            elif system == "bios":
                destinations.append(Path("media/bios") / tail)
        digest = sha256(path)
        entry = {"source": relative.as_posix(), "size": path.stat().st_size,
                 "sha256": digest, "destinations": [dest.as_posix() for dest in destinations]}
        entries.append(entry)
        for dest in destinations:
            key = dest.as_posix().casefold()
            if key in planned:
                raise ValueError(f"normalized destination collision: {dest}")
            planned[key] = (path, output / dest, digest)

    manifest = {"schema_version": 1, "source_root": str(source),
                "rom_count": len(roms), "files": entries}
    manifest_path = output / "manifest.json"
    _check_destination(output, manifest_path)
    if manifest_path.exists():
        try:
            previous = json.loads(manifest_path.read_text())
        except (OSError, ValueError) as error:
            raise ValueError(f"existing manifest cannot be read: {manifest_path}") from error
        if previous != manifest:
            raise ValueError("existing manifest conflicts with source; use a new output directory")

    # Check the whole plan before creating any output. Existing unrelated data
    # must survive even if a conflict is found late in the list.
    for _, destination, digest in planned.values():
        _check_destination(output, destination)
        if destination.exists() and (not destination.is_file() or sha256(destination) != digest):
            raise ValueError(f"destination conflict: {destination}")
        parent = destination.parent
        while parent != output.parent:
            if parent.exists() and not parent.is_dir():
                raise ValueError(f"destination parent conflict: {parent}")
            if parent == output:
                break
            parent = parent.parent
    for path, destination, digest in planned.values():
        _copy_verified(path, destination, digest)
    for entry in entries:
        if sha256(source / entry["source"]) != entry["sha256"]:
            raise ValueError(f"source changed during migration: {entry['source']}")
    if not manifest_path.exists():
        output.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".retrogo-manifest-", dir=output)
        temporary = Path(temporary)
        try:
            with os.fdopen(descriptor, "w") as handle:
                json.dump(manifest, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
            os.link(temporary, manifest_path)
        finally:
            temporary.unlink()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Legacy roms/ directory")
    parser.add_argument("--output", required=True, type=Path, help="New private local library directory")
    args = parser.parse_args()
    try:
        manifest = migrate_assets(args.source, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"migration failed: {error}\n")
    print(f"Verified {len(manifest['files'])} original files and {manifest['rom_count']} ROMs")
    print(f"Media: {args.output.resolve() / 'media'}")
    print(f"Manifest: {args.output.resolve() / 'manifest.json'}")


if __name__ == "__main__":
    main()
