#!/bin/sh
# Drive the bench on the Windows host that has the ST-Link attached.
#
#   hwtest/hw_remote.sh probe                    # connect only, no halt
#   hwtest/hw_remote.sh ram     CONTEXT NAME [RESET]  # phase A: load into ITCM and run
#   hwtest/hw_remote.sh bank2   CONTEXT NAME [RESET]  # phase B: run the copy in bank 2
#   hwtest/hw_remote.sh bank2sha                 # sha256 of bank 2 (halt/resume, no reset)
#
# CONTEXT = current | retrogo (see run_bench.tcl).  RESET = 1 (default) resets
# the chip afterwards; the stock firmware then goes to standby until the power
# button is pressed.  RESET = 0 leaves the bench idling so the next run can halt it.  Results land in
# hwtest/results/NAME.bin plus NAME.log.
set -eu
# GNW_HOST=user@windows-host (ssh, required); GNW_REMOTE_DIR = bench directory there.
HOST=${GNW_HOST:?set GNW_HOST=user@host of the machine with the ST-Link}
RDIR=${GNW_REMOTE_DIR:-D:/LLM_Work/Game_Watch/hwtest}
OCD_ARGS='-f interface/stlink.cfg -c "transport select swd; adapter speed 1800; reset_config none" -f target/stm32h7x.cfg'
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HERE/results"

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }
push() {
    remote "if not exist D:\\LLM_Work\\Game_Watch\\hwtest mkdir D:\\LLM_Work\\Game_Watch\\hwtest" >/dev/null
    scp -q "$@" "$HOST:$RDIR/"
}

case "$1" in
probe)
    remote "cd /d D:\\LLM_Work\\Game_Watch\\hwtest 2>nul & openocd $OCD_ARGS -c \"init; echo [format IDCODE=%08x [lindex [read_memory 0x5C001000 32 1] 0]]; shutdown\"" 2>&1 | grep -v "^Info : \(clock\|Listening\|Hardware\)" ;;
ram|bank2)
    ctx=$2 name=$3 reset=${4:-1}
    push "$HERE/run_bench.tcl"
    if [ "$1" = ram ]; then
        push "$HERE/build/bench_ram.bin"
        vars="set ::IMAGE bench_ram.bin; set ::BASE 0x00000000"
    else
        vars="set ::IMAGE {}; set ::BASE 0x08138000"
    fi
    remote "cd /d D:\\LLM_Work\\Game_Watch\\hwtest && openocd $OCD_ARGS -c \"$vars; set ::OUT $name.bin; set ::CONTEXT $ctx; set ::RESET $reset\" -f run_bench.tcl" \
        >"$HERE/results/$name.log" 2>&1 || true
    grep -E "RETROGO|HALTED|LOADED|ENTRY|STATUS|RESULT|ERROR|RESET|RESUMED|Error" "$HERE/results/$name.log" || true
    scp -q "$HOST:$RDIR/$name.bin" "$HERE/results/$name.bin" && echo "fetched results/$name.bin" ;;
bank2sha)
    remote "cd /d D:\\LLM_Work\\Game_Watch\\hwtest && openocd $OCD_ARGS -c \"init; halt; mww 0x5C001054 [expr {[lindex [read_memory 0x5C001054 32 1] 0] | 0x40000}]; mww 0x5C001034 [expr {[lindex [read_memory 0x5C001034 32 1] 0] | 0x40}]; dump_image bank2_now.bin 0x08100000 0x40000; resume; shutdown\"" >/dev/null 2>&1
    scp -q "$HOST:$RDIR/bank2_now.bin" /tmp/bank2_now.bin
    shasum -a 256 /tmp/bank2_now.bin ;;
*)
    echo "usage: $0 probe | ram CONTEXT NAME | bank2 CONTEXT NAME | bank2sha" >&2
    exit 2 ;;
esac
