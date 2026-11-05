#!/bin/sh
# Build Retro-Go SD (sylverb/game-and-watch-retro-go-sd) for the emulator:
# firmware for internal flash bank 2, sd_content/ and retro-go_update.bin.
#
#   RETROGO_SD=../retro-go-sd  checkout (git worktree) of the SD branch
#   GCC_PATH=...               arm-none-eabi toolchain bin directory
#   PYTHON_VENV=...            venv with the Retro-Go requirements.txt
#   extra make variables can be given as arguments (e.g. GNW_TARGET=mario)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RG=${RETROGO_SD:-$ROOT/../retro-go-sd}
GCC_PATH=${GCC_PATH:-/opt/gcc-arm-none-eabi-10.3-2021.10/bin}
PYTHON_VENV=${PYTHON_VENV:-$ROOT/../.venv-rgsd}

[ -d "$PYTHON_VENV/bin" ] && PATH=$PYTHON_VENV/bin:$PATH
[ -d /opt/homebrew/bin ] && PATH=$PATH:/opt/homebrew/bin
export PATH

cd "$RG"
# The firmware_update sub-build downloads its own HAL; doing that under -j
# races with the compile rules, so fetch both SDKs first.
make GCC_PATH="$GCC_PATH" download_sdk >/dev/null
make -C external/firmware_update GCC_PATH="$GCC_PATH" download_sdk >/dev/null
make -j8 GCC_PATH="$GCC_PATH" CHECK_DIRTY_SUBMODULE=0 SD_CARD=1 \
    GNW_TARGET=zelda INTFLASH_BANK=2 COVERFLOW=1 "$@" release
ls -l build/gw_retro_go_intflash.bin release/retro-go_update.bin
