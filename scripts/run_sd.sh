#!/bin/sh
# Retro-Go SD, direct: a full device backup (stock + dual boot) with the SD
# build of Retro-Go in bank 2 and a microSD card image.
#
#   scripts/run_sd.sh [BACKUP_DIR] [Electron application flags]
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
#   FRESH=1               new identity; rebuild a generated card, never explicit SDCARD
#   FRESH=1 creates a new JSON identity; previous saves are retained.
#
# The script writes out/profiles/sd-<backup name>-<wiring>.gnw.json and runs it.
# Saves live in UserData/kernels/gwemu/sessions/<profile id>/. The SD card is copied
# there on first launch; the source image is left unchanged.
#
# Keys: arrows = D-pad, X = A, Z = B, G = GAME, T = TIME, P = PAUSE,
#       O = POWER.  Hold LEFT + G on the clock to enter Retro-Go.
#       In Retro-Go: G = START, T = SELECT, P = in-game menu.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WS=$(cd "$ROOT/.." && pwd)
B=${GNW_BACKUP_DIR:-$WS/game-and-watch-backup/backups/full_20261104_1021}
case ${1:-} in
-*|"") ;;
*) B=$1; shift ;;
esac
B=$(cd "$B" && pwd)
ROMS=${ROMS:-$WS/xx/game-and-watch-retro-go/roms}
. "$ROOT/scripts/launch_common.sh"
select_sd_assets
GNW_EXPLICIT_CARD=${SDCARD:-}
SDCARD=${SDCARD:-$ASSETS/out/sd/sdcard.img}
# FRESH may rebuild our generated card, never an explicitly supplied source.
if [ "${FRESH:-0}" = 1 ] && [ -z "$GNW_EXPLICIT_CARD" ]; then
    SDCARD=$ROOT/out/sd/sdcard.img
fi
FWBIN=$RG/build/gw_retro_go_intflash.bin

for f in bank1.bin ext.bin; do
    [ -f "$B/$f" ] || { echo "missing $B/$f" >&2; exit 1; }
done
prepare_desktop
if [ ! -f "$FWBIN" ]; then
    [ "$ASSETS" = "$ROOT" ] || { echo "Missing prepared firmware: $FWBIN" >&2; exit 1; }
    "$ROOT/scripts/build_retrogo_sd.sh"
fi
if [ ! -f "$SDCARD" ] && ! ls "$ASSETS"/out/dl/*/x/cores/*.bin >/dev/null 2>&1; then
    [ "$ASSETS" = "$ROOT" ] || { echo "Missing prepared cores under $ASSETS/out/dl" >&2; exit 1; }
    if [ "${CORES_FROM:-release}" = source ]; then
        "$ROOT/scripts/build_cores.sh"
    else
        "$ROOT/scripts/fetch_cores.sh"
    fi
fi

NAME=$(basename "$B")

# Retro-Go SD finds the stock firmware (and keeps its ROM cache clear of
# the stock data in external flash) through a metadata word at bank1+0x1B8,
# the unused HDMI-CEC vector, which the --sd-bootloader patch writes:
# ext size in 4 KiB units, must_be_4, is_zelda.  Older patches (e.g. this
# backup) lack it, so use a copy of bank 1 with the word added.
BANK1=$ROOT/out/sd/${NAME}_bank1.bin
mkdir -p "$(dirname "$BANK1")"
python3 - "$B/bank1.bin" "$BANK1" <<'PY'
import struct, sys
b = bytearray(open(sys.argv[1], "rb").read())
word = struct.unpack_from("<I", b, 0x1B8)[0]
if (word >> 24) & 0xF != 4:
    struct.pack_into("<I", b, 0x1B8, (4 << 24) | (1 << 29) | ((4 << 20) >> 12))
    print("bank1  : added the Retro-Go SD metadata word (4 MiB stock data)")
open(sys.argv[2], "wb").write(b)
PY
PROFILE=$ROOT/out/profiles/sd-$NAME-${SD_WIRING:-spi1}.gnw.json
if [ ! -f "$SDCARD" ] || { [ "${FRESH:-0}" = 1 ] && [ -z "$GNW_EXPLICIT_CARD" ]; }; then
    mkdir -p "$(dirname "$SDCARD")"
    if [ -n "${SYSTEMS:-}" ]; then
        python3 "$ROOT/scripts/make_sd_image.py" "$SDCARD" --retrogo "$RG" --dl "$ASSETS/out/dl" --roms "$ROMS" --systems "$SYSTEMS"
    else
        python3 "$ROOT/scripts/make_sd_image.py" "$SDCARD" --retrogo "$RG" --dl "$ASSETS/out/dl" --roms "$ROMS"
    fi
fi
ensure_rom "$PROFILE" zelda internalFlash="$BANK1" externalFlash="$B/ext.bin" bank2Flash="$FWBIN" sdCard="$SDCARD" sdWiring="${SD_WIRING:-spi1}"
SESS=$(print_session_directory "$@")

echo "backup  : $B (bank1 + metadata, ext)"
echo "bank2   : $FWBIN"
echo "card    : $SDCARD (${SD_WIRING:-spi1})"
echo "profile : $PROFILE"
echo "saves   : $SESS + on the card"
echo "Hold LEFT + G on the clock to enter Retro-Go SD."

exec "$ROOT/scripts/run.sh" "$PROFILE" "$@"
