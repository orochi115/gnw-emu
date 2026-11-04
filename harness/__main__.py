"""Command line front end for headless runs.

    python -m harness run [--model zelda] [--deterministic] SCRIPT...

A script is a list of steps, given inline or with --script FILE (one step
per line, '#' comments):

    wait MS                 run for MS milliseconds of guest time
    press BUTTONS [MS]      hold BUTTONS (e.g. a, up+b) for MS (default 100)
                            then release and run 100 ms
    hold BUTTONS            press and keep holding
    release                 release all buttons
    shot FILE.png           save a screenshot
    regs                    print CPU registers
    mem ADDR LEN FILE       dump guest memory

Example:
    python -m harness run --deterministic \\
        "wait 3000" "shot clock.png" "press game" "wait 1000" "shot menu.png"
"""
import argparse
import shlex
import sys

from .gnw import BUTTONS, GnW


def run_script(gw: GnW, steps):
    for raw in steps:
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        op, *args = shlex.split(line)
        if op == "wait":
            gw.run(float(args[0]))
        elif op == "press":
            gw.press(args[0], float(args[1]) if len(args) > 1 else 100)
        elif op == "hold":
            gw.set_buttons(args[0])
        elif op == "release":
            gw.set_buttons(0)
        elif op == "shot":
            print("screenshot", gw.screenshot(args[0]))
        elif op == "regs":
            print(gw.hmp("info registers"))
        elif op == "mem":
            data = gw.read_mem(int(args[0], 0), int(args[1], 0))
            open(args[2], "wb").write(data)
        else:
            raise SystemExit(f"unknown step: {raw!r}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m harness")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run a scripted headless session")
    r.add_argument("steps", nargs="*")
    r.add_argument("--script", help="file with one step per line")
    r.add_argument("--model", default="zelda", choices=["zelda", "mario"])
    r.add_argument("--deterministic", action="store_true",
                   help="use -icount so runs are reproducible")
    r.add_argument("--overlay", help="writable SPI flash copy for saves")
    r.add_argument("--wav", help="capture audio to this WAV file")
    r.add_argument("--log", help="write -d unimp,guest_errors log here")
    r.add_argument("--rtc", default="2026-01-01T09:00:00",
                   help="RTC start time (ISO), or 'host' for the host clock")
    r.add_argument("--internal", help="bank 1 image (default: firmware/)")
    r.add_argument("--external", help="SPI flash image (default: firmware/)")
    r.add_argument("--bank2", help="bank 2 image (e.g. Retro-Go)")
    sub.add_parser("buttons", help="list button names")
    a = ap.parse_args(argv)

    if a.cmd == "buttons":
        print(" ".join(BUTTONS))
        return
    steps = list(a.steps)
    if a.script:
        steps += open(a.script).read().splitlines()
    with GnW(a.model, deterministic=a.deterministic, overlay=a.overlay,
             wav=a.wav, log=a.log, internal=a.internal,
             external=a.external, bank2=a.bank2,
             rtc=None if a.rtc == "host" else a.rtc) as gw:
        run_script(gw, steps)
        print(f"guest time {gw.vtime_ms:.0f} ms", file=sys.stderr)


if __name__ == "__main__":
    main()
