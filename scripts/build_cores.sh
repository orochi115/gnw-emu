#!/bin/sh
# Build the Retro-Go SD emulator cores and the SD bootloader from source
# (submodules under externals/cores/, pinned to the release tags that
# scripts/fetch_cores.sh downloads) and check them against those releases.
#
#   scripts/build_cores.sh [NAME...]     default: all of them
#
# NAME is a core (fceumm tgb-dual SMSPlusGX gwenesis prosystem potator
# caprice32 blueMSX LCD-Game-Emulator pce-go) or "bootloader".
#
# Same toolchains as the upstream CI, so the results are byte-identical:
#   cores       sylverb/retro-go-sd-builder:v1.5 (Arm GNU Toolchain 15.2.rel1),
#               pinned by digest; `make all`, then the repo's own
#               scripts/stage_release.py builds the SD zip like the release
#   bootloader  Arm GNU Toolchain 13.3.rel1 (x86_64 Linux, cached in
#               out/toolchains/), DEBUG=0 at 0x08000000 and 0x08032000
# Both run in linux/amd64 containers (Docker Desktop; Rosetta on Apple
# silicon).
#
# Output goes to $DL (default out/dl), in the layout fetch_cores.sh uses:
# <name>/x/{cores,bios}/... and bootloader/*.bin, so make_sd_image.py picks
# it up.  VERIFY=1 (default) downloads the releases into out/dl-release and
# compares every file; VERIFY=0 skips that.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DL=${DL:-$ROOT/out/dl}
REL=${REL:-$ROOT/out/dl-release}
VERIFY=${VERIFY:-1}
IMAGE=sylverb/retro-go-sd-builder@sha256:948725b822603810687c2b0331d0105c30167f4cf8157b210fd452f20db94691
TC=arm-gnu-toolchain-13.3.rel1-x86_64-arm-none-eabi
TC_URL=https://developer.arm.com/-/media/Files/downloads/gnu/13.3.rel1/binrel/$TC.tar.xz
ALL="fceumm tgb-dual SMSPlusGX gwenesis prosystem potator caprice32 blueMSX LCD-Game-Emulator pce-go bootloader"
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc)

# Docker Desktop keeps its credential helper outside the default PATH.
[ -d /Applications/Docker.app/Contents/Resources/bin ] &&
    PATH=$PATH:/Applications/Docker.app/Contents/Resources/bin
docker info >/dev/null 2>&1 || {
    echo "Docker is not running (open -a Docker)" >&2
    exit 1
}

# The whole gnw-emu tree is mounted so the submodules' .git files (which
# point into gnw-emu/.git/modules) resolve inside the container.
run() {    # run DIR IMAGE CMD...: docker run in DIR (relative to gnw-emu)
    dir=$1; shift
    docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" \
        -e HOME=/tmp -e GIT_CONFIG_COUNT=1 \
        -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
        -v "$ROOT:/opt/gnw" -w "/opt/gnw/${dir#$ROOT/}" "$@"
}

build_core() {    # build_core NAME
    name=$1
    src=$ROOT/externals/cores/$name-retro-go-sd
    git -C "$ROOT" submodule update --init --recursive "externals/cores/$name-retro-go-sd"
    tag=$(git -C "$src" describe --tags --exact-match)
    echo "== $name $tag"
    run "$src" "$IMAGE" make --no-print-directory -j"$JOBS" all CORE_VERSION="$tag"
    [ "$name" = blueMSX ] && run "$src" "$IMAGE" make --no-print-directory bios
    mk() { run "$src" "$IMAGE" make --no-print-directory -s "print-$1" 2>/dev/null || true; }
    bin=$(mk PACKED_BIN); elf=$(mk TARGET_ELF); map=$(mk TARGET_MAP)
    xip=$(grep -q '^print-XIP_BIN' "$src/Makefile" && mk XIP_BIN || true)
    # The print targets also parse host/Makefile.host, whose dependency flags
    # leave a file named "-DUSE_HAL_DRIVER" behind when SDL2 is missing.
    rm -f "$src/-DUSE_HAL_DRIVER"
    set -- --bin "$bin" --elf "$elf" --map "$map" --tag "$tag" --out build/gnw-stage
    [ -n "$xip" ] && set -- "$@" --sidecar "$xip"
    rm -rf "$src/build/gnw-stage"
    run "$src" "$IMAGE" python3 scripts/stage_release.py "$@" >/dev/null
    zip=$(ls "$src"/build/gnw-stage/*.zip | grep -v -- -debug.zip)
    rm -rf "$DL/$name/x"
    mkdir -p "$DL/$name/x"
    unzip -q -o "$zip" -d "$DL/$name/x"
    rm -rf "$src/build/gnw-stage"
}

build_bootloader() {
    src=$ROOT/externals/cores/game-and-watch-bootloader
    git -C "$ROOT" submodule update --init --recursive externals/cores/game-and-watch-bootloader
    echo "== bootloader $(git -C "$src" describe --tags --exact-match)"
    mkdir -p "$ROOT/out/toolchains"
    if [ ! -x "$ROOT/out/toolchains/$TC/bin/arm-none-eabi-gcc" ]; then
        curl -fL -o "$ROOT/out/toolchains/$TC.tar.xz" "$TC_URL"
        tar -C "$ROOT/out/toolchains" -xf "$ROOT/out/toolchains/$TC.tar.xz"
        rm "$ROOT/out/toolchains/$TC.tar.xz"
    fi
    mkdir -p "$DL/bootloader"
    # -j1: with a parallel make, lto1 13.3 under amd64 emulation dies with an
    # internal compiler error (opts-common.cc return_token).
    for addr in "" 0x08032000; do
        run "$src" "$IMAGE" sh -c "make clean >/dev/null && \
            DEBUG=0 ${addr:+INTFLASH_ADDRESS=$addr} make -j1 \
            GCC_PATH=/opt/gnw/out/toolchains/$TC/bin >/dev/null"
        cp "$src/build/gnw_bootloader.bin" \
           "$DL/bootloader/gnw_bootloader${addr:+_$addr}.bin"
    done
    run "$src" "$IMAGE" make clean >/dev/null
}

set -- ${*:-$ALL}
for n in "$@"; do
    case $n in
    bootloader) build_bootloader ;;
    *) build_core "$n" ;;
    esac
done

[ "$VERIFY" = 1 ] || exit 0
echo "== comparing with the GitHub releases ($REL)"
cores=$(printf '%s\n' "$@" | grep -vx bootloader | tr '\n' ' ')
DL=$REL CORES="$cores" "$ROOT/scripts/fetch_cores.sh" >/dev/null
fail=0
for n in "$@"; do
    if [ "$n" = bootloader ]; then a=$REL/bootloader; b=$DL/bootloader
    else a=$REL/$n/x; b=$DL/$n/x; fi
    for f in $(cd "$a" && find . -type f | sort); do
        if cmp -s "$a/$f" "$b/$f"; then
            echo "  same     $n/${f#./}"
        else
            echo "  DIFFERS  $n/${f#./}"; fail=1
        fi
    done
    extra=$(cd "$b" && find . -type f | sort | while read -r f; do
        [ -e "$a/$f" ] || echo "${f#./}"; done)
    [ -z "$extra" ] || { echo "  not in release: $n/$extra"; fail=1; }
done
[ $fail = 0 ] && echo "all built files are identical to the releases"
exit $fail
