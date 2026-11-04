#!/usr/bin/env python3
"""Decode bench result tables (bench.h) and compare runs.

    python3 parse.py RESULT.bin                    # print one run
    python3 parse.py --json OUT.json RESULT.bin    # also write JSON
    python3 parse.py --compare A.bin B.bin [...]   # Markdown table, first = reference

Derived numbers (all in CPU cycles of the run's own clock):
  kernels      cycles per op = (cmin - empty * iters) / ops, empty = loop
               overhead measured in the same region and cache config
  ld_lat       load-to-use latency = ld_lat step - alu2_lat step
  rtc_hz       CPU clock in Hz, from CYCCNT against the RTC (LSE, 32768 Hz)
  systick/tim  timer counts per CPU cycle
  ltdc         frame period in cycles and Hz, line period in cycles
  dma2d        cycles per pixel; dma1: bytes per cycle; cryp: cycles per block
  irq          entry: pend store -> first handler instruction; return: last
               handler instruction -> thread code (includes the probe's
               dsb/isb and CYCCNT loads)
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAGIC = 0x424E5747
STATUS = {0x454E4F44: "DONE", 0x544C5546: "FAULT", 0x52554E21: "RUNNING"}
REGIONS = ["none", "code", "itcm", "dtcm", "axi", "ahb", "srd", "flash1", "flash2", "ospi"]
CFGS = ["cache_off", "cache_on"]
NSNAP, NMPU = 104, 8
HDR_FMT = "<8I12I" + f"{NMPU * 2}I" + f"{NSNAP}I"
ENTRY_FMT = "<HBBIIII"


def load_defs():
    tests = {}
    for m in re.finditer(r"^T\((\d+),\s*(\w+),\s*(\w+)\)", (HERE / "tests.def").read_text(), re.M):
        tests[int(m.group(1))] = (m.group(2), m.group(3))
    snaps = re.findall(r"^S\((\w+),\s*(0x[0-9A-Fa-f]+)\)", (HERE / "snap.def").read_text(), re.M)
    return tests, [s[0] for s in snaps]


TESTS, SNAP_NAMES = load_defs()
KERNEL_IDS = set(range(0, 32))


def decode(data: bytes) -> dict:
    h = struct.unpack_from(HDR_FMT, data)
    magic, version, status, progress, n, build, flags, nsnap = h[:8]
    if magic != MAGIC:
        raise ValueError(f"bad magic {magic:#x} (bench did not start?)")
    fault = h[8:20]
    mpu = [h[20 + 2 * i:22 + 2 * i] for i in range(NMPU)]
    snap = dict(zip(SNAP_NAMES, h[20 + 2 * NMPU:20 + 2 * NMPU + nsnap]))
    off = struct.calcsize(HDR_FMT)
    entries = []
    for i in range(n):
        test, region, cfg, iters, ops, cmin, cmax = struct.unpack_from(ENTRY_FMT, data, off + 20 * i)
        name, unit = TESTS.get(test, (f"t{test}", "?"))
        entries.append(dict(test=name, unit=unit, region=REGIONS[region], cfg=CFGS[cfg],
                            iters=iters, ops=ops, cmin=cmin, cmax=cmax))
    run = dict(version=version, status=STATUS.get(status, hex(status)),
               progress=dict(test=progress & 0xFF, region=(progress >> 8) & 0xFF,
                             cfg=(progress >> 16) & 0xF, entries=progress >> 20),
               build=["ram", "bank2"][build] if build < 2 else build,
               ospi_mapped=bool(flags & 1),
               snap={k: f"{v:#010x}" for k, v in snap.items()},
               mpu=[[f"{a:#010x}", f"{b:#010x}"] for a, b in mpu],
               entries=entries)
    if run["status"] == "FAULT":
        run["fault"] = dict(zip("CFSR HFSR MMFAR BFAR IPSR r0 r1 r2 r3 r12 lr pc".split(),
                                [f"{v:#010x}" for v in fault]))
    run["derived"] = derive(run)
    return run


def derive(run: dict) -> dict:
    """Turn raw entries into per-op numbers keyed 'test/region/cfg'."""
    e = run["entries"]
    idx = {(x["test"], x["region"], x["cfg"]): x for x in e}
    out = {}

    def empty_per_iter(region, cfg, fetch):
        key = ("fetch_empty", region, cfg) if fetch and region != "code" else ("empty", "code", cfg)
        if fetch and region == "code":
            key = ("fetch_empty", "code", cfg)
        x = idx.get(key)
        return x["cmin"] / x["iters"] if x else 0.0

    for x in e:
        name, region, cfg = x["test"], x["region"], x["cfg"]
        key = f"{name}/{region}/{cfg}"
        tid = next(k for k, v in TESTS.items() if v[0] == name)
        if tid in KERNEL_IDS and name not in ("empty", "fetch_empty"):
            fetch = name.startswith("fetch_")
            ovh = empty_per_iter(region, cfg, fetch) * x["iters"]
            out[key] = round((x["cmin"] - ovh) / x["ops"], 3) if x["ops"] else None
    # load latency = ld_lat step - alu2 step (same cfg)
    for k in list(out):
        name, region, cfg = k.split("/")
        if name == "ld_lat":
            alu = out.get(f"alu2_lat/code/{cfg}")
            if alu is not None:
                out[f"load_latency/{region}/{cfg}"] = round(out[k] - alu, 3)
    hz = None
    for x in e:
        n, c = x["test"], x["cmin"]
        if n == "rtc_hz" and x["ops"]:
            seconds = x["ops"] * x["iters"] / 32768
            hz = c / seconds
            out["cpu_hz"] = round(hz)
        elif n in ("systick_cpu", "systick_ref", "tim2") and c:
            out[f"{n}_per_cycle"] = round(x["ops"] / c, 5)
        elif n == "ltdc_frame" and x["ops"]:
            out["ltdc_frame_cycles"] = round(c / x["ops"])
        elif n == "ltdc_lines" and x["ops"]:
            out["ltdc_line_cycles"] = round(c / x["ops"], 1)
        elif n.startswith("dma2d_"):
            out[f"{n}_cycles_per_pixel"] = round(c / x["ops"], 3) if x["iters"] != 0xFFFFFFFF else "error"
        elif n.startswith("dma1_"):
            out[f"{n}_bytes_per_cycle"] = round(4 * x["ops"] / c, 3) if x["iters"] != 0xFFFFFFFF and c else "error"
        elif n == "cryp_ecb":
            out["cryp_cycles_per_block"] = round(c / x["ops"], 1) if x["iters"] != 0xFFFFFFFF else "error"
        elif n.startswith("irq_"):
            out[f"{n}/{x['cfg']}"] = c
        elif n == "cpu_memcpy":
            out[f"memcpy_bytes_per_cycle/{x['cfg']}"] = round(x["ops"] / c, 3)
    if hz and "ltdc_frame_cycles" in out:
        out["ltdc_hz"] = round(hz / out["ltdc_frame_cycles"], 3)
    return out


def show(run: dict, path: str):
    print(f"# {path}: status {run['status']}, build {run['build']}, ospi mapped {run['ospi_mapped']}")
    if run["status"] != "DONE":
        print("progress", run["progress"])
    if "fault" in run:
        print("fault", run["fault"])
    s = run["snap"]
    print(f"CCR {s['CCR']} MPU_CTRL {s['MPU_CTRL']} FLASH_ACR {s['FLASH_ACR']} "
          f"SYST_RVR {s['SYST_RVR']} RCC_CFGR {s['RCC_CFGR']} PLL1DIVR {s['RCC_PLL1DIVR']}")
    for k, v in run["derived"].items():
        print(f"  {k:40s} {v}")
    spread = [x for x in run["entries"] if x["cmin"] and (x["cmax"] - x["cmin"]) / x["cmin"] > 0.01]
    if spread:
        print(f"  ({len(spread)} entries vary by more than 1% between runs)")


def compare(runs: list[tuple[str, dict]]):
    keys = []
    for _, r in runs:
        for k in r["derived"]:
            if k not in keys:
                keys.append(k)
    names = [Path(p).stem for p, _ in runs]
    print("| metric | " + " | ".join(names) + (" | ratio |" if len(runs) == 2 else " |"))
    print("|---" * (len(runs) + 1 + (len(runs) == 2)) + "|")
    for k in keys:
        vals = [r["derived"].get(k) for _, r in runs]
        cells = ["" if v is None else str(v) for v in vals]
        ratio = ""
        if len(runs) == 2 and all(isinstance(v, (int, float)) and v for v in vals):
            ratio = f" {vals[1] / vals[0]:.2f} |"
        elif len(runs) == 2:
            ratio = " |"
        print(f"| {k} | " + " | ".join(cells) + " |" + ratio)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--compare", action="store_true")
    args = ap.parse_args()
    runs = [(f, decode(Path(f).read_bytes())) for f in args.files]
    if args.compare:
        compare(runs)
    else:
        for f, r in runs:
            show(r, f)
    if args.json:
        payload = {Path(f).name: r for f, r in runs} if len(runs) > 1 else runs[0][1]
        Path(args.json).write_text(json.dumps(payload, indent=1))


if __name__ == "__main__":
    sys.exit(main())
