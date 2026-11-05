#!/bin/sh
# Patch the stock Zelda firmware for a Retro-Go SD dual boot (what
# `gnwmanager flash-patch zelda ... --bootloader` installs): LEFT+GAME jumps
# to the SD bootloader at 0x08032000.  Output in
# externals/game-and-watch-patch/build/{internal,external}_flash_patched.bin,
# then scripts/make_sd_dualboot.py assembles the emulator images.
#
#   FW=../firmware        directory with the stock dumps
#   GCC_PATH=...          arm-none-eabi toolchain bin directory
#   PYTHON_VENV=...       venv (gets requirements.txt + setuptools)
#
# keystone (the assembler the patcher uses) ships no arm64 library in its
# Python package; `brew install keystone` provides one.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
P=$ROOT/externals/game-and-watch-patch
FW=${FW:-$ROOT/../firmware}
GCC_PATH=${GCC_PATH:-/opt/gcc-arm-none-eabi-10.3-2021.10/bin}
PYTHON_VENV=${PYTHON_VENV:-$ROOT/../.venv-rgsd}

git -C "$ROOT" submodule update --init externals/game-and-watch-patch
[ -d "$PYTHON_VENV" ] || python3 -m venv "$PYTHON_VENV"
"$PYTHON_VENV/bin/pip" install -q -r "$P/requirements.txt" setuptools
PATH=$PYTHON_VENV/bin:$PATH
[ -d /opt/homebrew/lib ] && export DYLD_LIBRARY_PATH=/opt/homebrew/lib
export PATH
python -c "import keystone" 2>/dev/null || {
    echo "keystone cannot load its library: brew install keystone" >&2
    exit 1
}

# The patcher reads the dumps from its working directory (*.bin is ignored).
for f in internal_flash_backup_zelda.bin flash_backup_zelda.bin itcm_backup_zelda.bin; do
    cp "$FW/$f" "$P/"
done
cd "$P"
make GCC_PATH="$GCC_PATH" download_sdk >/dev/null
make -j8 GCC_PATH="$GCC_PATH" PATCH_PARAMS="--device=zelda --sd-bootloader"
ls -l build/internal_flash_patched.bin build/external_flash_patched.bin
