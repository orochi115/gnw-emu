#!/bin/sh
# Run the stock firmware in a window.
#   scripts/run.sh [zelda|mario] [extra qemu args...]
# Keys: arrows = D-pad, X = A, Z = B, G = GAME, T = TIME, P = PAUSE,
#       O = POWER, Return = START, Tab = SELECT (Zelda only).
# Saves go to out/<model>_flash.bin (created from the dump on first run);
# the files in firmware/ are never modified.
# Timing: -icount with realtime=on, so every timer fires at its exact
# instruction count (~250 MIPS, like the 280 MHz core) at host speed.
# Env overrides: INTERNAL=, EXTERNAL=, BANK2= (e.g. a full device backup),
# OVERLAY= (defaults to out/<model>_flash.bin).
# Battery: BATTERY=0..100 (default 100), USB_POWER=on|off (default off),
#   BATTERY_LIFE_MIN= (default 480), CHARGE_TIME_MIN= (default 180).
#   In the window: '-' / '=' change the level by 10 %, C plugs/unplugs USB.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODEL=${1:-zelda}; [ $# -gt 0 ] && shift
FW=${FW:-$ROOT/../firmware}
mkdir -p "$ROOT/out"
exec "$ROOT/build/qemu-system-arm" \
    -M gnw-$MODEL,internal=${INTERNAL:-$FW/internal_flash_backup_$MODEL.bin},external=${EXTERNAL:-$FW/flash_backup_$MODEL.bin},overlay=${OVERLAY:-$ROOT/out/${MODEL}_flash.bin}${BANK2:+,bank2=$BANK2},audio=on,realtime=on,battery=${BATTERY:-100},usb-power=${USB_POWER:-off}${BATTERY_LIFE_MIN:+,battery-life-min=$BATTERY_LIFE_MIN}${CHARGE_TIME_MIN:+,charge-time-min=$CHARGE_TIME_MIN} \
    -icount shift=2,sleep=off \
    -rtc base=localtime -display ${DISPLAY_BACKEND:-cocoa,zoom-to-fit=on} "$@"
