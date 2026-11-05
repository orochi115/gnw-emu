#!/bin/sh
# Retro-Go SD, direct: a full device backup (stock + dual boot) with the SD
# build of Retro-Go in bank 2 and a microSD card image.
#
#   scripts/run_sd.sh [BACKUP_DIR] [extra qemu args...]
#
# BACKUP_DIR defaults to ../game-and-watch-backup/backups/full_20261104_1021
# (bank1.bin + ext.bin are used; the backup itself is never modified).
# Whatever is missing is prepared first: the firmware
# (scripts/build_retrogo_sd.sh), cores (scripts/fetch_cores.sh, or
# scripts/build_cores.sh with CORES_FROM=source) and the card image.
#
#   SD_WIRING=spi1|ospi   SD mod wiring (default spi1)
#   ROMS=DIR              old Retro-Go roms/ tree for the card
#                         (default ../xx/game-and-watch-retro-go/roms)
#   SYSTEMS=nes,gb,...    only these systems on the card
#   SDCARD=FILE           card image (default out/sd/sdcard.img)
#   FRESH=1               rebuild the card image and drop the flash overlay
#   BATTERY=, USB_POWER=, ... are passed to scripts/run.sh
#
# Keys: arrows = D-pad, X = A, Z = B, G = GAME, T = TIME, P = PAUSE,
#       O = POWER.  Hold LEFT + G on the clock to enter Retro-Go.
#       In Retro-Go: G = START, T = SELECT, P = in-game menu.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WS=$(cd "$ROOT/.." && pwd)
B=$WS/game-and-watch-backup/backups/full_20261104_1021
case ${1:-} in
-*|"") ;;
*) B=$1; shift ;;
esac
B=$(cd "$B" && pwd)
ROMS=${ROMS:-$WS/xx/game-and-watch-retro-go/roms}
SDCARD=${SDCARD:-$ROOT/out/sd/sdcard.img}
RG=$ROOT/externals/retro-go-sd
FWBIN=$RG/build/gw_retro_go_intflash.bin

for f in bank1.bin ext.bin; do
    [ -f "$B/$f" ] || { echo "missing $B/$f" >&2; exit 1; }
done
[ -x "$ROOT/build/qemu-system-arm" ] || "$ROOT/scripts/build.sh"
[ -f "$FWBIN" ] || "$ROOT/scripts/build_retrogo_sd.sh"
if ! ls "$ROOT"/out/dl/*/x/cores/*.bin >/dev/null 2>&1; then
    if [ "${CORES_FROM:-release}" = source ]; then
        "$ROOT/scripts/build_cores.sh"
    else
        "$ROOT/scripts/fetch_cores.sh"
    fi
fi

OVERLAY=$ROOT/out/sd/$(basename "$B")_ext.bin
if [ "${FRESH:-0}" = 1 ]; then
    rm -f "$SDCARD" "$OVERLAY"
fi
if [ ! -f "$SDCARD" ]; then
    mkdir -p "$(dirname "$SDCARD")"
    python3 "$ROOT/scripts/make_sd_image.py" "$SDCARD" --roms "$ROMS" \
        ${SYSTEMS:+--systems "$SYSTEMS"}
fi

echo "backup : $B (bank1, ext)"
echo "bank2  : $FWBIN"
echo "card   : $SDCARD (${SD_WIRING:-spi1})"
echo "saves  : $OVERLAY + on the card"
echo "Hold LEFT + G on the clock to enter Retro-Go SD."

INTERNAL=$B/bank1.bin EXTERNAL=$B/ext.bin BANK2=$FWBIN OVERLAY=$OVERLAY \
SDCARD=$SDCARD SD_WIRING=${SD_WIRING:-spi1} \
    exec "$ROOT/scripts/run.sh" zelda "$@"
