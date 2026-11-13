#!/bin/sh
# Retro-Go SD, as installed on a device: the stock firmware patched for an
# SD dual boot (bootloader at 0x08032000), bank 2 erased, and a card with
# retro-go_update.bin.  The bootloader installs Retro-Go into bank 2 from
# the card, like a first install or an update on the real console.
#
#   scripts/run_sd_update.sh [Electron application flags]
#
#   1. clock (stock firmware) -> hold LEFT + G
#      The freshly patched flash has no settings yet, so the stock firmware
#      starts with "PRESS TIME BUTTON": TIME goes on to the clock, LEFT + G
#      works on that screen too.
#   2. "Updating firmware" ... "Firmware update done" -> press any button
#   3. clock again -> hold LEFT + G -> Retro-Go SD
#
# The script writes out/profiles/sd-update-<wiring>.gnw.json. Bank 2 in that profile
# is a blank 256 KiB image; the installed firmware is the session's
# bank2.bin under UserData/kernels/gwemu/sessions/<profile id>/. The source card stays
# out/sd/update/card.img; the running copy is the session's sdcard.img.
# FRESH=1 creates a new JSON identity and rebuilds our generated card only.
# An explicitly supplied SDCARD is never rebuilt.
# Previous application saves are retained.
#
# Prepared when missing: the patched firmware (scripts/build_sd_patch.sh,
# needs ../firmware/*_zelda.bin and `brew install keystone`), the Retro-Go
# SD build, cores and the SD bootloader.
#
#   SD_WIRING=spi1|ospi, ROMS=DIR, SYSTEMS=nes,gb  as in scripts/run_sd.sh
# Existing saves are reused only while the JSON profile is unchanged.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WS=$(cd "$ROOT/.." && pwd)
if [ -n "${ROMS:-}" ]; then
    ROMS_ARG=--roms
else
    ROMS_ARG=--assets
    ROMS=$ROOT/local/retrogo-assets/media
fi
D=$ROOT/out/sd/update
. "$ROOT/scripts/launch_common.sh"
select_sd_assets
DB=$ASSETS/out/sd/dualboot
CARD=${SDCARD:-$ASSETS/out/sd/update/card.img}
GNW_EXPLICIT_CARD=${SDCARD:-}
if [ "${FRESH:-0}" = 1 ] && [ -z "$GNW_EXPLICIT_CARD" ]; then CARD=$D/card.img; fi

prepare_desktop
if [ ! -f "$DB/bank1.bin" ] || [ ! -f "$DB/ext.bin" ]; then
    [ "$ASSETS" = "$ROOT" ] || { echo "Missing prepared dualboot images under $DB" >&2; exit 1; }
    [ -f "$RG/release/retro-go_update.bin" ] || "$ROOT/scripts/build_retrogo_sd.sh"
    [ -f "$ROOT/out/dl/bootloader/gnw_bootloader_0x08032000.bin" ] || "$ROOT/scripts/fetch_cores.sh"
    [ -f "$ROOT/externals/game-and-watch-patch/build/internal_flash_patched.bin" ] || "$ROOT/scripts/build_sd_patch.sh"
    python3 "$ROOT/scripts/make_sd_dualboot.py" "$DB"
fi
if [ ! -f "$CARD" ]; then
    [ -f "$RG/release/retro-go_update.bin" ] || { echo "Missing SD update firmware: $RG/release/retro-go_update.bin" >&2; exit 1; }
    if ! ls "$ASSETS"/out/dl/*/x/cores/*.bin >/dev/null 2>&1; then
        [ "$ASSETS" = "$ROOT" ] || { echo "Missing prepared cores under $ASSETS/out/dl" >&2; exit 1; }
        if [ "${CORES_FROM:-release}" = source ]; then "$ROOT/scripts/build_cores.sh"; else "$ROOT/scripts/fetch_cores.sh"; fi
    fi
fi

PROFILE=$ROOT/out/profiles/sd-update-${SD_WIRING:-spi1}.gnw.json
BLANK=$D/bank2-blank.bin
mkdir -p "$D"
if [ ! -f "$BLANK" ]; then
    python3 - "$BLANK" <<'PY'
import sys
open(sys.argv[1], "wb").write(b"\xff" * (256 * 1024))
PY
fi
if [ ! -f "$CARD" ] || { [ "${FRESH:-0}" = 1 ] && [ -z "$GNW_EXPLICIT_CARD" ]; }; then
    mkdir -p "$(dirname "$CARD")"
    if [ -n "${SYSTEMS:-}" ]; then
        python3 "$ROOT/scripts/make_sd_image.py" "$CARD" --retrogo "$RG" --dl "$ASSETS/out/dl" "$ROMS_ARG" "$ROMS" --systems "$SYSTEMS" --with-update
    else
        python3 "$ROOT/scripts/make_sd_image.py" "$CARD" --retrogo "$RG" --dl "$ASSETS/out/dl" "$ROMS_ARG" "$ROMS" --with-update
    fi
fi
ensure_rom "$PROFILE" zelda internalFlash="$DB/bank1.bin" externalFlash="$DB/ext.bin" bank2Flash="$BLANK" sdCard="$CARD" sdWiring="${SD_WIRING:-spi1}"
SESS=$(print_session_directory "$@")

echo "bank1   : $DB/bank1.bin (patched stock + SD bootloader)"
echo "bank2   : blank, until the update writes the session copy"
echo "card    : $CARD (${SD_WIRING:-spi1}, with retro-go_update.bin)"
echo "profile : $PROFILE"
echo "saves   : $SESS"
echo "LEFT + G: update -> any button -> LEFT + G: Retro-Go SD.  FRESH=1 to redo."
echo "First boot shows \"PRESS TIME BUTTON\": press T (TIME), or LEFT + G directly."

exec "$ROOT/scripts/run.sh" "$PROFILE" "$@"
