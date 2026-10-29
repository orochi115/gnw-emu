#!/bin/sh
# Build qemu-system-arm with the Game & Watch machine.
#
# Upstream QEMU lives in ../qemu (clone of https://gitlab.com/qemu-project/qemu,
# tag v11.1.3). Our sources in qemu-gnw/ are symlinked into it and hooked into
# hw/arm/meson.build and hw/arm/Kconfig; both edits are idempotent.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
QEMU=${QEMU_SRC:-$ROOT/../qemu}
BUILD=$ROOT/build

if [ ! -d "$QEMU" ]; then
    git clone --depth 1 --branch v11.1.3 https://gitlab.com/qemu-project/qemu.git "$QEMU"
fi

ln -sfn "$ROOT/qemu-gnw/hw/arm/gnw" "$QEMU/hw/arm/gnw"
grep -q "^subdir('gnw')" "$QEMU/hw/arm/meson.build" ||
    sed -i.orig "1a\\
subdir('gnw')
" "$QEMU/hw/arm/meson.build"
grep -q "^source gnw/Kconfig" "$QEMU/hw/arm/Kconfig" ||
    printf "\nsource gnw/Kconfig\n" >> "$QEMU/hw/arm/Kconfig"

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
