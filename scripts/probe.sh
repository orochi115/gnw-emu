#!/bin/sh
# Debug helper: run the Zelda firmware headless for N seconds, then print the
# CPU registers, save a screenshot and summarise the -d unimp log.
#   scripts/probe.sh [seconds] [extra qemu args...]
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODEL=${MODEL:-zelda}
PROFILE=${PROFILE:-$ROOT/profiles/$MODEL.gnw.toml}
OUT=${OUT:-/tmp/gnw}
SECS=${1:-4}; [ $# -gt 0 ] && shift
mkdir -p "$OUT"; rm -f "$OUT/log.txt" "$OUT/mon.sock"
# Read the images from the profile. No session: this run does not save.
eval "$(python3 "$ROOT/harness/profile.py" paths "$PROFILE")"
"$ROOT/build/qemu-system-arm" -M gnw-$MODEL,internal=$INTERNAL,external=$EXTERNAL \
    -display none -d unimp,guest_errors -D "$OUT/log.txt" \
    -monitor unix:$OUT/mon.sock,server,nowait "$@" &
PID=$!
sleep "$SECS"
(echo "info registers"; sleep 0.3; echo "screendump $OUT/shot.png -f png"; sleep 0.5; echo quit) |
    nc -U "$OUT/mon.sock" | grep -E "^R|PSR" | tr -d '\r'
wait $PID 2>/dev/null
echo "--- log: $(wc -l < "$OUT/log.txt") lines; most frequent:"
sort "$OUT/log.txt" | uniq -c | sort -rn | head -${TOP:-25}
