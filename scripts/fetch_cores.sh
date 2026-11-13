#!/bin/sh
# Download Retro-Go SD emulator cores and the SD bootloader from their
# GitHub releases (sylverb/*-retro-go-sd) into out/dl/.  Each zip is
# unpacked into its own directory (<name>/x/), laid out like the SD card
# (cores/, bios/, ...).  Needs the gh CLI.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DL=${DL:-$ROOT/out/dl}
CORES=${CORES:-"fceumm tgb-dual SMSPlusGX gwenesis prosystem potator caprice32 blueMSX LCD-Game-Emulator pce-go"}

mkdir -p "$DL"
for c in $CORES; do
    git -C "$ROOT" submodule update --init "externals/cores/$c-retro-go-sd"
    tag=$(git -C "$ROOT/externals/cores/$c-retro-go-sd" describe --tags --exact-match)
    mkdir -p "$DL/$c"
    gh release download "$tag" -R "sylverb/$c-retro-go-sd" -D "$DL/$c" \
        --skip-existing -p '*.zip'
    for z in "$DL/$c"/*.zip; do
        case "$z" in *-debug.zip) continue ;; *-"$tag".zip) ;; *) continue ;; esac
        rm -rf "$DL/$c/x"
        mkdir "$DL/$c/x"
        unzip -q -o "$z" -d "$DL/$c/x"
    done
    echo "$c: $(cd "$DL/$c/x" && find . -type f | wc -l | tr -d ' ') files"
done

mkdir -p "$DL/bootloader"
git -C "$ROOT" submodule update --init externals/cores/game-and-watch-bootloader
tag=$(git -C "$ROOT/externals/cores/game-and-watch-bootloader" describe --tags --exact-match)
gh release download "$tag" -R sylverb/game-and-watch-bootloader -D "$DL/bootloader" \
    --skip-existing -p '*.bin'
ls "$DL/bootloader"
