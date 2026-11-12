#!/bin/sh
# Build only the RAM manager and its independent Python acceptance environment.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=${GNWMANAGER_SOURCE:-$ROOT/externals/gnwmanager}
BUILD=${GNWMANAGER_BUILD_DIR:-$ROOT/build/gnwmanager-ram-final}
VENV=${GNWMANAGER_VENV:-$ROOT/build/gnwmanager-python}
PYTHON=${GNWMANAGER_PYTHON:-python3}
JOBS=${GNWMANAGER_JOBS:-4}
MANAGER_DEBUG=${DEBUG-0}
if [ "$MANAGER_DEBUG" = "1" ]; then
    MANAGER_OPT=${OPT--Og}
else
    MANAGER_OPT=${OPT--Os}
fi
if [ ! -f "$SOURCE/Makefile" ] || [ ! -f "$SOURCE/gnwmanager/gnw_patch/README.md" ]; then
    echo "Initialize pinned externals/gnwmanager and its gnwmanager/gnw_patch submodule first." >&2
    exit 1
fi
SOURCE=$(cd "$SOURCE" && pwd)
mkdir -p "$BUILD"
BUILD=$(cd "$BUILD" && pwd)
if [ ! -x "$VENV/bin/python" ]; then
    "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --disable-pip-version-check -e "$SOURCE" pytest pytest-mock qemu.qmp
"$VENV/bin/python" "$ROOT/scripts/gnwmanager-build-manifest.py" check "$SOURCE" "$BUILD"
make -C "$SOURCE" -j "$JOBS" "BUILD_DIR=$BUILD" "DEBUG=$MANAGER_DEBUG" "OPT=$MANAGER_OPT" gnwmanager/firmware.bin
"$VENV/bin/python" "$ROOT/scripts/gnwmanager-build-manifest.py" record "$SOURCE" "$BUILD"
echo "Opt-in synthetic RAM acceptance:"
echo "GWEMU_MANAGER_TEST=1 GWEMU_BINARY=build/gwemu-savestate/qemu-system-arm GNWMANAGER_MANIFEST=$BUILD/gnwmanager-build-manifest.json GNWMANAGER_PYTHON_ENV=$VENV/bin/python $VENV/bin/python -m pytest -q tests/test_gwemu_manager.py"
