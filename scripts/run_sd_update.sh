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
# The script writes out/profiles/sd-update.gnw.json. Bank 2 in that profile
# is a blank 256 KiB image; the installed firmware is the session's
# bank2.bin under UserData/sessions/<profile id>/. The source card stays
# out/sd/update/card.img; the running copy is the session's sdcard.img.
# FRESH=1 rebuilds the source card and creates a new JSON identity.
# Previous application saves are retained.
#
# Prepared when missing: the patched firmware (scripts/build_sd_patch.sh,
# needs ../firmware/*_zelda.bin and `brew install keystone`), the Retro-Go
# SD build, cores and the SD bootloader.
#
#   SD_WIRING=spi1|ospi, ROMS=DIR, SYSTEMS=nes,gb  as in scripts/run_sd.sh
# Existing saves are reused only while the JSON profile is unchanged.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WS=$(cd "$ROOT/.." && pwd)
ROMS=${ROMS:-$WS/xx/game-and-watch-retro-go/roms}
D=$ROOT/out/sd/update
DB=$ROOT/out/sd/dualboot
RG=$ROOT/externals/retro-go-sd

[ -x "$ROOT/build/qemu-system-arm" ] || "$ROOT/scripts/build.sh"
[ -f "$RG/release/retro-go_update.bin" ] || "$ROOT/scripts/build_retrogo_sd.sh"
if ! ls "$ROOT"/out/dl/*/x/cores/*.bin >/dev/null 2>&1 ||
   [ ! -f "$ROOT/out/dl/bootloader/gnw_bootloader_0x08032000.bin" ]; then
    if [ "${CORES_FROM:-release}" = source ]; then
        "$ROOT/scripts/build_cores.sh"
    else
        "$ROOT/scripts/fetch_cores.sh"
    fi
fi
if [ ! -f "$DB/bank1.bin" ]; then
    [ -f "$ROOT/externals/game-and-watch-patch/build/internal_flash_patched.bin" ] ||
        "$ROOT/scripts/build_sd_patch.sh"
    python3 "$ROOT/scripts/make_sd_dualboot.py" "$DB"
fi

PROFILE=$ROOT/out/profiles/sd-update.gnw.json
BLANK=$D/bank2-blank.bin
if [ "${FRESH:-0}" = 1 ]; then
    rm -rf "$D"
fi
mkdir -p "$D"
if [ ! -f "$BLANK" ]; then
    python3 - "$BLANK" <<'PY'
import sys
open(sys.argv[1], "wb").write(b"\xff" * (256 * 1024))
PY
fi
if [ ! -f "$D/card.img" ]; then
    python3 "$ROOT/scripts/make_sd_image.py" "$D/card.img" --roms "$ROMS" \
        ${SYSTEMS:+--systems "$SYSTEMS"} --with-update
fi
node "$ROOT/desktop/dist-cli/cli.js" ensure "$PROFILE" zelda \
    internalFlash="$DB/bank1.bin" externalFlash="$DB/ext.bin" bank2Flash="$BLANK" \
    sdCard="$D/card.img" sdWiring="${SD_WIRING:-spi1}" $(if [ "${FRESH:-0}" = 1 ]; then echo --fresh; fi)
SESS=$(node "$ROOT/desktop/dist-cli/cli.js" session-dir "$PROFILE")

echo "bank1   : $DB/bank1.bin (patched stock + SD bootloader)"
echo "bank2   : blank, until the update writes the session copy"
echo "card    : $D/card.img (${SD_WIRING:-spi1}, with retro-go_update.bin)"
echo "profile : $PROFILE"
echo "saves   : $SESS"
echo "LEFT + G: update -> any button -> LEFT + G: Retro-Go SD.  FRESH=1 to redo."
echo "First boot shows \"PRESS TIME BUTTON\": press T (TIME), or LEFT + G directly."

exec "$ROOT/scripts/run.sh" "$PROFILE" "$@"
