#!/usr/bin/env python3
"""Run the bench inside gnw-emu the same way run_ram.tcl runs it on the device.

    .venv/bin/python hwtest/emu_run.py --context stock   --out hwtest/results/emu_stock_ram.bin
    .venv/bin/python hwtest/emu_run.py --context retrogo --out hwtest/results/emu_retrogo_ram.bin
    .venv/bin/python hwtest/emu_run.py --build bank2 --context retrogo --out ...

Boots the firmware (stock clock screen, or Retro-Go via LEFT+GAME), pauses
in thread mode, writes the image and registers through QEMU's gdbstub (a
tiny RSP client below; no gdb needed), resumes and waits for status DONE.
"""
from __future__ import annotations

import argparse
import os
import socket
import struct
import sys
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from harness import GnW  # noqa: E402

RES_ADDR, RES_SIZE = 0x2001E000, 0x2000
ST_DONE, ST_FAULT, ST_RUNNING = 0x454E4F44, 0x544C5546, 0x52554E21
BANK2_BENCH_OFF = 0x38000


def default_backup() -> Path | None:
    env = os.environ.get("GNW_FULL_BACKUP")
    if env:
        return Path(env)
    found = sorted((HERE.parent.parent / "game-and-watch-backup" / "backups").glob("full_*"))
    return found[-1] if found else None


class Rsp:
    """Minimal GDB remote serial protocol client (enough for QEMU's gdbstub)."""

    def __init__(self, port: int):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.buf = b""
        self.regnums = {}

    def _read_packet(self) -> str:
        while True:
            i = self.buf.find(b"$")
            j = self.buf.find(b"#", i + 1) if i >= 0 else -1
            if i >= 0 and j >= 0 and len(self.buf) >= j + 3:
                data = self.buf[i + 1:j]
                self.buf = self.buf[j + 3:]
                self.s.sendall(b"+")
                return data.decode("latin-1")
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("gdbstub closed")
            self.buf += chunk

    def cmd(self, data: str) -> str:
        cs = sum(data.encode("latin-1")) & 0xFF
        self.s.sendall(f"${data}#{cs:02x}".encode("latin-1"))
        while True:
            reply = self._read_packet()
            if reply.startswith("O") and reply != "OK":   # console output
                continue
            return reply

    def xfer(self, name: str) -> str:
        out, off = "", 0
        while True:
            r = self.cmd(f"qXfer:features:read:{name}:{off:x},fff")
            out += r[1:]
            off += len(r) - 1
            if r.startswith("l"):
                return out

    def load_regnums(self):
        # QEMU's target.xml uses xi:include without declaring the namespace,
        # so parse it with regular expressions.  Registers are numbered in
        # document order unless a regnum attribute resets the count.
        n = 0

        def regs(xml: str):
            nonlocal n
            for m in re.finditer(r"<reg\b([^>]*)>", xml):
                attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
                if "regnum" in attrs:
                    n = int(attrs["regnum"])
                self.regnums[attrs["name"]] = n
                n += 1

        top = self.xfer("target.xml")
        for href in re.findall(r'<xi:include href="([^"]+)"', top):
            regs(self.xfer(href))
        regs(top)

    def set_reg(self, name: str, value: int):
        n = self.regnums[name]
        r = self.cmd(f"P{n:x}={struct.pack('<I', value).hex()}")
        if r != "OK":
            raise RuntimeError(f"P {name}: {r}")

    def get_reg(self, name: str) -> int:
        r = self.cmd(f"p{self.regnums[name]:x}")
        return struct.unpack("<I", bytes.fromhex(r[:8]))[0]

    def write_mem(self, addr: int, data: bytes):
        for off in range(0, len(data), 1024):
            chunk = data[off:off + 1024]
            r = self.cmd(f"M{addr + off:x},{len(chunk):x}:{chunk.hex()}")
            if r != "OK":
                raise RuntimeError(f"M {addr + off:#x}: {r}")

    def detach(self):
        try:
            self.cmd("D")
        finally:
            self.s.close()


def boot(gw: GnW, context: str):
    if context == "stock":
        gw.run(3000)
    elif context == "retrogo":
        gw.run(500)
        gw.set_buttons("left+game")
        gw.run(1500)
        gw.set_buttons(0)
        gw.run(3000)
    else:
        raise SystemExit(f"unknown context {context}")
    # Pause in thread mode (IPSR = 0), like run_ram.tcl does on the device.
    for _ in range(200):
        if gw.registers()["XPSR"] & 0x1FF == 0:
            return
        gw.run(1)
    raise RuntimeError("could not pause in thread mode")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--context", default="stock", choices=["stock", "retrogo"])
    ap.add_argument("--build", default="ram", choices=["ram", "bank2"])
    ap.add_argument("--backup", type=Path, default=default_backup())
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--port", type=int, default=12399)
    ap.add_argument("--timeout-ms", type=int, default=60000)
    args = ap.parse_args()

    b = args.backup
    bank2 = b / "bank2.bin"
    if args.build == "bank2":
        bank2 = HERE / "build" / "bank2_with_bench.bin"
        image_base = 0x08138000
    else:
        image = (HERE / "build" / "bench_ram.bin").read_bytes()
        image_base = 0x00000000

    with GnW("zelda", deterministic=True, internal=str(b / "bank1.bin"),
             external=str(b / "ext.bin"), bank2=str(bank2),
             extra=["-gdb", f"tcp::{args.port}"]) as gw:
        boot(gw, args.context)
        rsp = Rsp(args.port)
        rsp.load_regnums()
        if args.build == "ram":
            rsp.write_mem(image_base, image)
        sp, entry = struct.unpack("<II", gw.read_mem(image_base, 8))
        rsp.write_mem(RES_ADDR, b"\0" * 64)
        rsp.set_reg("primask", 1)
        rsp.set_reg("msp", sp)
        rsp.set_reg("sp", sp)
        rsp.set_reg("xpsr", 0x01000000)
        rsp.set_reg("pc", entry & ~1)
        rsp.detach()
        gw.qmp.cmd("stop")

        status = 0
        t = 0
        while t < args.timeout_ms:
            gw.run(500)
            t += 500
            status = struct.unpack("<I", gw.read_mem(RES_ADDR + 8, 4))[0]
            if status in (ST_DONE, ST_FAULT):
                break
        data = gw.read_mem(RES_ADDR, RES_SIZE)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(data)
    names = {ST_DONE: "DONE", ST_FAULT: "FAULT", ST_RUNNING: "RUNNING (timeout)"}
    print(f"{args.out}: status {names.get(status, hex(status))} after ~{t} ms virtual time")
    return 0 if status == ST_DONE else 1


if __name__ == "__main__":
    sys.exit(main())
