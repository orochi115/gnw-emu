"""List peripherals referenced by literal pools in firmware images.

Usage: scan_mmio.py SVD IMAGE[:BASE] ...
Prints each SVD peripheral that any aligned 32-bit word points into, with a
count and the distinct register offsets seen.
"""
import struct
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict


def load_svd(path):
    root = ET.parse(path).getroot()
    periphs = []
    for p in root.iter("peripheral"):
        name = p.findtext("name")
        base = int(p.findtext("baseAddress"), 0)
        size = 0x400
        ab = p.find("addressBlock")
        if ab is not None:
            size = int(ab.findtext("size"), 0)
        periphs.append((base, base + size, name))
    periphs.sort()
    return periphs


def main():
    periphs = load_svd(sys.argv[1])
    hits = defaultdict(lambda: defaultdict(int))
    for arg in sys.argv[2:]:
        path, _, _ = arg.partition(":")
        data = open(path, "rb").read()
        for (w,) in struct.iter_unpack("<I", data[: len(data) // 4 * 4]):
            if not (0x40000000 <= w < 0x60000000):
                continue
            for lo, hi, name in periphs:
                if lo <= w < hi:
                    hits[(lo, name)][w - lo] += 1
                    break
    for (lo, name), offs in sorted(hits.items()):
        total = sum(offs.values())
        if total < 2:
            continue
        o = " ".join(f"{k:x}" for k in sorted(offs)[:12])
        print(f"{lo:08x} {name:12s} {total:5d}  {o}")


if __name__ == "__main__":
    main()
