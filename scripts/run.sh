#!/bin/sh
# Run in a window.
#   scripts/run.sh [zelda|mario] [extra qemu args...]
#   scripts/run.sh path/to/machine.gnw.toml [extra qemu args...]
#
# zelda / mario load profiles/zelda.gnw.toml and profiles/mario.gnw.toml.
# A .gnw.toml profile names the read-only images. Battery, RTC and the
# writable flash copies and the SD card working copy live in
# UserData/sessions/<profile id>/. See docs/profiles.md.
#
# One-run overrides: BATTERY, USB_POWER, BATTERY_LIFE_MIN, CHARGE_TIME_MIN,
# RTC, DISPLAY_BACKEND. They are not written into the profile.
#
# Host-wide audio, display, realtime pacing and the recent list:
# UserData/settings.toml (created on the first window run).
# Keys: arrows = D-pad, X = A, Z = B, G = GAME,
# T = TIME, P = PAUSE, O = POWER, Return = START, Tab = SELECT (Zelda).
# '-' / '=' change the battery by 10 %, C plugs or unplugs USB.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "$GNW_PYTHON" ]; then
    PY=$GNW_PYTHON
elif [ -x "$ROOT/.venv/bin/python" ]; then
    PY=$ROOT/.venv/bin/python
else
    PY=python3
fi
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m harness.launch "$@"
