"""Retro-Go SD firmware symbols, independent of emulator runtimes."""
import os
import shutil
import subprocess
from pathlib import Path

from .assets import ROOT

RETROGO_SD = Path(os.environ.get("GNW_RETROGO_SD", ROOT / "externals/retro-go-sd"))
ELF = RETROGO_SD / "build/gw_retro_go.elf"


def find_nm():
    for directory in filter(None, [os.environ.get("GCC_PATH"),
                                   "/opt/gcc-arm-none-eabi-10.3-2021.10/bin"]):
        path = Path(directory) / "arm-none-eabi-nm"
        if path.exists():
            return str(path)
    return shutil.which("arm-none-eabi-nm")


NM = find_nm()


def symbols():
    output = subprocess.run([NM, str(ELF)], capture_output=True, text=True,
                            check=True).stdout
    return {line.split()[2]: int(line.split()[0], 16)
            for line in output.splitlines() if len(line.split()) == 3}
