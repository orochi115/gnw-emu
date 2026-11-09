#!/bin/sh
# scripts/run_backup.sh [BACKUP_DIR] [Electron flags]. Never modifies dumps.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WS=$(cd "$ROOT/.." && pwd)
. "$ROOT/scripts/launch_common.sh"
B=${GNW_BACKUP_DIR:-$WS/game-and-watch-backup/backups/full_20261104_1021}
case ${1:-} in -*) ;; "") ;; *) B=$1; shift ;; esac
B=$(cd "$B" && pwd)
for f in bank1.bin bank2.bin ext.bin; do
    [ -f "$B/$f" ] || { echo "missing $B/$f" >&2; exit 1; }
done
prepare_desktop
NAME=$(basename "$B")
PROFILE=$ROOT/out/profiles/backup-$NAME.gnw.json
ensure_rom "$PROFILE" zelda internalFlash="$B/bank1.bin" externalFlash="$B/ext.bin" bank2Flash="$B/bank2.bin"
echo "backup  : $B"
echo "profile : $PROFILE"
echo "saves   : $(print_session_directory "$@")"
exec "$ROOT/scripts/run.sh" "$PROFILE" "$@"
