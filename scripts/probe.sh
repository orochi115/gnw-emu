#!/bin/sh
# Isolated headless diagnostic; never opens an application session.
# scripts/probe.sh [seconds]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROFILE=${PROFILE:-$ROOT/profiles/${MODEL:-zelda}.gnw.json}
exec node "$ROOT/desktop/dist-cli/cli.js" probe "$PROFILE" "${1:-4}" "${OUT:-/tmp/gnw-probe}"
