#!/bin/sh
# Build the pinned gwemu kernel in its independent canonical directory.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec sh "$ROOT/scripts/build_gwemu.sh" "$@"
