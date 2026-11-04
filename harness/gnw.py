"""Headless driver for the Game & Watch QEMU machine.

    with GnW("zelda") as gw:
        gw.run(3000)                 # 3 s of guest time
        gw.press("a", 100)           # hold A for 100 ms
        gw.screenshot("menu.png")

The VM starts paused. run(ms) resumes it until the machine's
"stop-after-ms" timer pauses it again, so every step is measured in
virtual time. With deterministic=True QEMU runs with -icount and the same
inputs produce the same frames.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from qemu.qmp.legacy import QEMUMonitorProtocol

ROOT = Path(__file__).resolve().parent.parent
QEMU = ROOT / "build" / "qemu-system-arm"
FIRMWARE = ROOT.parent / "firmware"

BUTTONS = ["left", "up", "right", "down", "a", "b", "time", "game",
           "pause", "power", "start", "select"]


def button_mask(names) -> int:
    if isinstance(names, str):
        names = [n for n in re.split(r"[+, ]+", names) if n]
    mask = 0
    for n in names:
        mask |= 1 << BUTTONS.index(n.lower())
    return mask


class GnW:
    def __init__(self, model: str = "zelda", *, firmware: Path = FIRMWARE,
                 qemu: Path = QEMU, overlay: str | None = None,
                 rtc: str = "2026-01-01T09:00:00", deterministic: bool = False,
                 wav: str | None = None, log: str | None = None,
                 trace: str = "unimp,guest_errors", display: str = "none",
                 extra: list[str] | None = None,
                 internal: str | None = None, external: str | None = None,
                 bank2: str | None = None, audio: bool = False,
                 realtime: bool = False, battery: int | None = None,
                 usb: bool | None = None, battery_life_min: int | None = None,
                 charge_time_min: int | None = None):
        firmware = Path(firmware)
        self.model = model
        self.tmp = Path(tempfile.mkdtemp(prefix="gnw-"))
        self.sock = str(self.tmp / "qmp.sock")
        opts = [f"gnw-{model}",
                f"internal={internal or firmware / f'internal_flash_backup_{model}.bin'}",
                f"external={external or firmware / f'flash_backup_{model}.bin'}"]
        if bank2:
            opts.append(f"bank2={bank2}")
        if audio:
            opts.append("audio=on")
        if battery is not None:
            opts.append(f"battery={battery}")
        if usb is not None:
            opts.append(f"usb-power={'on' if usb else 'off'}")
        if battery_life_min is not None:
            opts.append(f"battery-life-min={battery_life_min}")
        if charge_time_min is not None:
            opts.append(f"charge-time-min={charge_time_min}")
        if realtime and not deterministic:
            # Exact timers (icount) paced to the host clock by the machine.
            opts.append("realtime=on")
        if overlay:
            opts.append(f"overlay={overlay}")
        if wav:
            opts.append(f"wav={wav}")
        self.args = [str(qemu), "-M", ",".join(opts),
                     "-display", display, "-S",
                     "-qmp", f"unix:{self.sock},server=on,wait=off",
                     "-rtc", f"base={rtc},clock=vm" if rtc else "base=localtime"]
        if deterministic:
            # 2^2 ns per instruction ~ 250 MIPS, close to the 280 MHz core.
            self.args += ["-icount", "shift=2,sleep=off"]
        elif realtime:
            self.args += ["-icount", "shift=2,sleep=off"]
        if log:
            self.args += ["-d", trace, "-D", log]
        self.args += extra or []
        self.proc: subprocess.Popen | None = None
        self.qmp: QEMUMonitorProtocol | None = None
        self.buttons = 0

    # -- lifecycle -----------------------------------------------------
    def start(self) -> "GnW":
        if self.proc:
            return self
        self.proc = subprocess.Popen(self.args, stdin=subprocess.DEVNULL)
        for _ in range(200):
            if os.path.exists(self.sock):
                break
            if self.proc.poll() is not None:
                raise RuntimeError(f"qemu exited: {self.proc.returncode}")
            time.sleep(0.02)
        self.qmp = QEMUMonitorProtocol(self.sock)
        self.qmp.connect()
        return self

    def close(self):
        if self.qmp:
            try:
                self.qmp.cmd("quit")
            except Exception:
                pass
            try:
                self.qmp.close()
            except Exception:
                pass
            self.qmp = None
        if self.proc:
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def __enter__(self):
        return self if self.proc else self.start()

    def __exit__(self, *exc):
        self.close()

    # -- time ----------------------------------------------------------
    @property
    def vtime_ms(self) -> float:
        return self.qmp.cmd("qom-get", path="/machine",
                            property="vtime-ns") / 1e6

    def run(self, ms: float, timeout: float | None = None):
        """Run for ms milliseconds of guest time, then pause."""
        if ms <= 0:
            return
        self.qmp.clear_events()
        self.qmp.cmd("qom-set", path="/machine", property="stop-after-ms",
                     value=int(ms))
        self.qmp.cmd("cont")
        deadline = time.time() + (timeout or max(30.0, ms / 1000 * 20))
        while time.time() < deadline:
            try:
                ev = self.qmp.pull_event(wait=0.5)
            except TimeoutError:
                ev = None
            if ev and ev["event"] == "STOP":
                return
            if self.proc.poll() is not None:
                raise RuntimeError("qemu exited while running")
        self.qmp.cmd("stop")
        raise TimeoutError(f"guest did not reach +{ms} ms in time")

    # -- battery -------------------------------------------------------
    @property
    def battery(self) -> int:
        return self.qmp.cmd("qom-get", path="/machine", property="battery")

    def set_battery(self, percent: int) -> None:
        self.qmp.cmd("qom-set", path="/machine", property="battery",
                     value=int(percent))

    @property
    def usb(self) -> bool:
        return self.qmp.cmd("qom-get", path="/machine", property="usb-power")

    def set_usb(self, connected: bool) -> None:
        self.qmp.cmd("qom-set", path="/machine", property="usb-power",
                     value=bool(connected))

    # -- input ---------------------------------------------------------
    def set_buttons(self, names) -> None:
        self.buttons = button_mask(names) if not isinstance(names, int) else names
        self.qmp.cmd("qom-set", path="/machine", property="buttons",
                     value=self.buttons)

    def press(self, names, ms: float = 100, release_ms: float = 100):
        """Hold buttons for ms, then release and run release_ms more."""
        self.set_buttons(names)
        self.run(ms)
        self.set_buttons(0)
        self.run(release_ms)

    # -- inspection ----------------------------------------------------
    def hmp(self, cmd: str) -> str:
        return self.qmp.cmd("human-monitor-command", **{"command-line": cmd})

    def registers(self) -> dict[str, int]:
        out = self.hmp("info registers")
        return {k: int(v, 16) for k, v in re.findall(r"(R\d\d|XPSR)=([0-9a-f]+)", out)}

    @property
    def pc(self) -> int:
        return self.registers()["R15"]

    def read_mem(self, addr: int, size: int) -> bytes:
        path = self.tmp / "mem.bin"
        self.qmp.cmd("pmemsave", val=addr, size=size, filename=str(path))
        return path.read_bytes()

    def screenshot(self, path: str | os.PathLike) -> Path:
        path = Path(path).resolve()
        self.qmp.cmd("screendump", filename=str(path), format="png")
        return path

    def frame(self):
        """Current screen as a PIL image."""
        from PIL import Image
        p = self.screenshot(self.tmp / "frame.png")
        img = Image.open(p)
        img.load()
        return img
