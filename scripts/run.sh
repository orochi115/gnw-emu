#!/bin/sh
# Electron main window. QEMU command-line flags belong to headless harness tests.
# scripts/run.sh [zelda|mario|FILE.gnw.json] [Electron application flags]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:-}
case "$TARGET" in
  --*) TARGET= ;;
  *) [ $# -eq 0 ] || shift ;;
esac
case "$TARGET" in
  zelda|mario) TARGET=$ROOT/profiles/$TARGET.gnw.json ;;
  "") ;;
esac
. "$ROOT/scripts/launch_common.sh"
prepare_desktop
if [ -n "$TARGET" ]; then
  exec node "$ROOT/desktop/dist-cli/cli.js" launch "$TARGET" "$@"
fi
exec node "$ROOT/desktop/dist-cli/cli.js" launch "$@"
