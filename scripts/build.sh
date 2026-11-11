#!/bin/sh
# Build qemu-system-arm with the Game & Watch machine.
#
# QEMU is the externals/qemu submodule: orochi115/qemu branch gnw = v11.1.3
# plus the hooks below, committed, and hw/arm/gnw as a symlink to our
# qemu-gnw/hw/arm/gnw.  The hook edits here are idempotent fallbacks for a
# plain upstream tree given with QEMU_SRC=.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
QEMU=${QEMU_SRC:-$ROOT/externals/qemu}
BUILD=$ROOT/build

if [ ! -f "$QEMU/configure" ]; then
    echo "no QEMU source in $QEMU: git submodule update --init externals/qemu" >&2
    exit 1
fi

[ -e "$QEMU/hw/arm/gnw" ] || ln -sfn "$ROOT/qemu-gnw/hw/arm/gnw" "$QEMU/hw/arm/gnw"
grep -q "^subdir('gnw')" "$QEMU/hw/arm/meson.build" ||
    sed -i.orig "1a\\
subdir('gnw')
" "$QEMU/hw/arm/meson.build"
grep -q "^source gnw/Kconfig" "$QEMU/hw/arm/Kconfig" ||
    printf "\nsource gnw/Kconfig\n" >> "$QEMU/hw/arm/Kconfig"

python3 "$ROOT/scripts/qemu-savestate-hook.py" "$QEMU"

# devkitPro and others ship a pkg-config that cannot see Homebrew's glib.
if [ -x /opt/homebrew/bin/pkg-config ]; then
    export PKG_CONFIG=/opt/homebrew/bin/pkg-config
fi

mkdir -p "$BUILD"
if [ ! -f "$BUILD/build.ninja" ]; then
    (cd "$BUILD" && "$QEMU/configure" --target-list=arm-softmmu \
        --disable-docs --disable-werror --disable-tools \
        --disable-guest-agent --disable-vnc)
fi
ninja -C "$BUILD" qemu-system-arm
