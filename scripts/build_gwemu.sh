#!/bin/sh
# Independent build of the pinned gwemu integration fork; never patches QEMU.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=${GWEMU_SRC:-$ROOT/externals/gwemu}
BUILD=${GWEMU_BUILD_DIR:-$ROOT/build/gwemu}
PYTHON=${GWEMU_PYTHON:-python3}
if ! command -v "$PYTHON" >/dev/null 2>&1 && [ -z "${GWEMU_PYTHON:-}" ]; then
    PYTHON=python
fi
if [ ! -f "$SOURCE/configure" ]; then
    echo "Missing gwemu source: git submodule update --init externals/gwemu" >&2
    exit 1
fi
SOURCE=$(cd "$SOURCE" && pwd)
mkdir -p "$BUILD"
BUILD=$(cd "$BUILD" && pwd)
if [ -x /opt/homebrew/bin/pkg-config ]; then
    export PKG_CONFIG=/opt/homebrew/bin/pkg-config
fi
set -- --target-list=arm-softmmu --disable-docs --disable-werror \
    --disable-tools --disable-guest-agent --disable-vnc \
    --disable-sdl --disable-sdl-image --disable-gtk
"$PYTHON" "$ROOT/scripts/gwemu-build-manifest.py" check "$SOURCE" "$BUILD" "$@"
if [ ! -f "$BUILD/build.ninja" ]; then
    (cd "$BUILD" && "$SOURCE/configure" --python="$(command -v "$PYTHON")" "$@")
    "$PYTHON" "$ROOT/scripts/gwemu-build-manifest.py" configured "$SOURCE" "$BUILD" "$@"
fi
# Upstream genconfig runs with QEMU's build interpreter, not the host pip.
BUILD_PYTHON=$BUILD/pyvenv/bin/python
[ -x "$BUILD_PYTHON" ] || BUILD_PYTHON=$BUILD/pyvenv/Scripts/python.exe
"$BUILD_PYTHON" -m pip install --disable-pip-version-check 'PyYAML==6.0.3'
TARGET=qemu-system-arm
case $(uname -s) in MINGW*|MSYS*) TARGET=$TARGET.exe ;; esac
ninja -C "$BUILD" "$TARGET"
case $(uname -s) in
    MINGW*|MSYS*)
        node "$ROOT/desktop/tools/collect-windows-dlls.mjs" \
            "$(cygpath -m "$BUILD/$TARGET")" "$(cygpath -m /ucrt64/bin)"
        ;;
esac
"$PYTHON" "$ROOT/scripts/gwemu-build-manifest.py" record "$SOURCE" "$BUILD" "$@"
