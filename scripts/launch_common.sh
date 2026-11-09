#!/bin/sh
# Sourced only after ROOT is resolved by a launcher. Never changes cwd.
prepare_desktop() {
    command -v node >/dev/null 2>&1 || { echo "Node.js is required (use Node 24 or later)." >&2; exit 1; }
    [ -x "$ROOT/build/qemu-system-arm" ] || "$ROOT/scripts/build.sh"
    if [ ! -d "$ROOT/desktop/node_modules" ]; then
        (cd "$ROOT/desktop" && npm ci)
    fi
    if [ ! -f "$ROOT/desktop/dist-cli/cli.js" ] || [ ! -f "$ROOT/desktop/out/main/index.js" ]; then
        (cd "$ROOT/desktop" && npm run build)
    fi
}
select_sd_assets() {
    ASSETS=${GNW_ASSET_DIR:-$ROOT}
    if [ -z "${GNW_ASSET_DIR:-}" ] &&
       [ ! -f "$ASSETS/externals/retro-go-sd/build/gw_retro_go_intflash.bin" ] &&
       [ -f "$WS/gnw-emu/externals/retro-go-sd/build/gw_retro_go_intflash.bin" ]; then
        ASSETS=$WS/gnw-emu
    fi
    ASSETS=$(cd "$ASSETS" && pwd)
    RG=$ASSETS/externals/retro-go-sd
}
# The displayed directory must match an explicitly overridden runtime directory.
print_session_directory() {
    GNW_SESSION_DATA=$ROOT/UserData
    for GNW_ARG in "$@"; do
        case "$GNW_ARG" in --user-data-dir=*) GNW_SESSION_DATA=${GNW_ARG#--user-data-dir=} ;; esac
    done
    GNW_USER_DATA="$GNW_SESSION_DATA" node "$ROOT/desktop/dist-cli/cli.js" session-dir "$PROFILE"
}
ensure_rom() {
    GNW_ENSURE_PATH=$1
    shift
    if [ "${FRESH:-0}" = 1 ]; then
        node "$ROOT/desktop/dist-cli/cli.js" ensure "$GNW_ENSURE_PATH" "$@" --fresh >/dev/null
    else
        node "$ROOT/desktop/dist-cli/cli.js" ensure "$GNW_ENSURE_PATH" "$@" >/dev/null
    fi
}
