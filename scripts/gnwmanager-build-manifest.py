#!/usr/bin/env python3
"""Record RAM firmware, exact source trees, compiler and installed Python tools."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def run(*args):
    return subprocess.check_output(args, text=True, encoding="utf-8", stderr=subprocess.STDOUT).strip()


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def provenance(source):
    return {"path": str(source), "revision": run("git", "-C", str(source), "rev-parse", "HEAD"),
            "dirty": bool(run("git", "-C", str(source), "status", "--porcelain", "--untracked-files=no")),
            "trackedDiffSha256": hashlib.sha256(run("git", "-C", str(source), "diff", "HEAD").encode()).hexdigest()}


def main():
    action, source, build = sys.argv[1:]
    source, build = Path(source).resolve(), Path(build).resolve()
    source_info = provenance(source)
    patch_info = provenance(source / "gnwmanager/gnw_patch")
    gcc_path = os.environ.get("GCC_PATH")
    compiler = (str(Path(gcc_path) / "arm-none-eabi-gcc") if gcc_path
                else shutil.which("arm-none-eabi-gcc"))
    if not compiler:
        sys.exit("arm-none-eabi-gcc is required")
    # Match Makefile's ?= defaults, including an explicit OPT override. Store
    # effective values so spelling the defaults explicitly is still equivalent.
    debug = os.environ.get("DEBUG", "0")
    opt = os.environ.get("OPT", "-Og" if debug == "1" else "-Os")
    signature = {"source": source_info, "patchSource": patch_info,
                 "compiler": {"path": compiler, "version": run(compiler, "--version")},
                 "buildSettings": {"DEBUG": debug, "OPT": opt},
                 "buildEnvironment": {name: os.environ.get(name) for name in
                                      ("CFLAGS", "LDFLAGS", "GCC_PATH")}}
    config = build / "gnwmanager-build-config.json"
    if action == "check":
        if list(build.glob("*.o")):
            if not config.exists() or json.loads(config.read_text()) != signature:
                sys.exit("Manager source/compiler changed or old build has no provenance; "
                         "select a fresh GNWMANAGER_BUILD_DIR. Existing objects were not modified.")
        config.write_text(json.dumps(signature, indent=2) + "\n")
    elif action == "record":
        if not config.exists() or json.loads(config.read_text()) != signature:
            sys.exit("Manager source changed during build; no manifest recorded")
        from gnwmanager import __file__ as package_path

        package_firmware = Path(package_path).parent / "firmware.bin"
        firmware = build / "gnwmanager.bin"
        assert digest(firmware) == digest(package_firmware), "package uploads a different firmware binary"
        dependencies = {distribution.metadata["Name"]: distribution.version
                        for distribution in importlib.metadata.distributions()}
        manifest = {**signature, "formatVersion": 1,
                    "buildCommand": ["make", "-C", str(source), "-j", os.environ.get("GNWMANAGER_JOBS", "4"),
                                     "BUILD_DIR=" + str(build), "DEBUG=" + debug,
                                     "OPT=" + opt, "gnwmanager/firmware.bin"],
                    "host": {"system": platform.system(), "architecture": platform.machine()},
                    "python": {"executable": sys.executable, "version": platform.python_version(),
                               "prefix": sys.prefix, "package": str(package_path),
                               "dependencies": dict(sorted(dependencies.items()))},
                    "artifacts": {name: {"path": str(path), "size": path.stat().st_size, "sha256": digest(path)}
                                  for name, path in (("elf", build / "gnwmanager.elf"),
                                                     ("firmware", firmware))},
                    "uploadedPackageFirmware": str(package_firmware)}
        path = build / "gnwmanager-build-manifest.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"manager {source_info['revision']}: {firmware}\nSHA-256 {digest(firmware)}\nManifest {path}")
    else:
        sys.exit("Unknown manifest action: " + action)


if __name__ == "__main__":
    main()
