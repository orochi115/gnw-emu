#!/bin/sh
# Retro-Go SD, as installed on a device: the stock firmware patched for an
# SD dual boot (bootloader at 0x08032000), bank 2 erased, and a card with
# retro-go_update.bin.  The bootloader installs Retro-Go into bank 2 from
# the card, like a first install or an update on the real console.
#
#   scripts/run_sd_update.sh [extra qemu args...]
#
#   1. clock (stock firmware) -> hold LEFT + G
#   2. "Updating firmware" ... "Firmware update done" -> press any button
#   3. clock again -> hold LEFT + G -> Retro-Go SD
#
# Flash and card state live in out/sd/update/ and survive restarts (the
# update file is gone from the card once installed).  FRESH=1 goes back to
# before the update: erased bank 2, new card image.
#
# Prepared when missing: the patched firmware (scripts/build_sd_patch.sh,
# needs ../firmware/*_zelda.bin and `brew install keystone`), the Retro-Go
# SD build, cores and the SD bootloader.
#
#   SD_WIRING=spi1|ospi, ROMS=DIR, SYSTEMS=nes,gb  as in scripts/run_sd.sh
#   BATTERY=, USB_POWER=, ...                      passed to scripts/run.sh
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

if [ "${FRESH:-0}" = 1 ]; then
    rm -rf "$D"
fi
mkdir -p "$D"
if [ ! -f "$D/card.img" ]; then
    python3 "$ROOT/scripts/make_sd_image.py" "$D/card.img" --roms "$ROMS" \
        ${SYSTEMS:+--systems "$SYSTEMS"} --with-update
    rm -f "$D/bank1.bin" "$D/bank2.bin" "$D/ext.bin"
fi

echo "bank1  : $DB/bank1.bin -> $D/bank1.bin (patched stock + SD bootloader)"
echo "bank2  : $D/bank2.bin (erased until the update runs)"
echo "card   : $D/card.img (${SD_WIRING:-spi1}, with retro-go_update.bin)"
echo "LEFT + G: update -> any button -> LEFT + G: Retro-Go SD.  FRESH=1 to redo."

INTERNAL=$DB/bank1.bin EXTERNAL=$DB/ext.bin OVERLAY=$D/ext.bin \
BANK1_OVERLAY=$D/bank1.bin BANK2_OVERLAY=$D/bank2.bin \
SDCARD=$D/card.img SD_WIRING=${SD_WIRING:-spi1} \
    exec "$ROOT/scripts/run.sh" zelda "$@"
