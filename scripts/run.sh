#!/bin/sh
# Run the stock firmware in a window.
#   scripts/run.sh [zelda|mario] [extra qemu args...]
# Keys: arrows = D-pad, X = A, Z = B, G = GAME, T = TIME, P = PAUSE,
#       O = POWER, Return = START, Tab = SELECT (Zelda only).
# Saves go to out/<model>_flash.bin (created from the dump on first run);
# the files in firmware/ are never modified.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODEL=${1:-zelda}; [ $# -gt 0 ] && shift
FW=${FW:-$ROOT/../firmware}
mkdir -p "$ROOT/out"
exec "$ROOT/build/qemu-system-arm" \
    -M gnw-$MODEL,internal=$FW/internal_flash_backup_$MODEL.bin,external=$FW/flash_backup_$MODEL.bin,overlay=$ROOT/out/${MODEL}_flash.bin \
    -rtc base=localtime -display ${DISPLAY_BACKEND:-cocoa,zoom-to-fit=on} "$@"
