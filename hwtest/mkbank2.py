#!/usr/bin/env python3
"""Build the bank-2 image for phase B: the backed-up bank 2 (Retro-Go) with
build/bench_bank2.bin placed in its erased tail at offset 0x38000.

    python3 mkbank2.py BACKUP_DIR/bank2.bin [build/bank2_with_bench.bin]

Refuses to run unless the target range is erased (all 0xFF) in the backup,
so Retro-Go itself stays byte-for-byte identical.
"""
import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OFF, LIMIT = 0x38000, 0x40000

src = Path(sys.argv[1]).read_bytes()
bench = (HERE / "build" / "bench_bank2.bin").read_bytes()
out = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "build" / "bank2_with_bench.bin"
if len(src) != LIMIT:
    sys.exit(f"bank2 backup is {len(src)} bytes, expected {LIMIT}")
if OFF + len(bench) > LIMIT:
    sys.exit("bench too large for the bank 2 tail")
if src[OFF:] != b"\xff" * (LIMIT - OFF):
    sys.exit("bank 2 tail is not erased in the backup; refusing")
img = src[:OFF] + bench + b"\xff" * (LIMIT - OFF - len(bench))
assert img[:OFF] == src[:OFF] and len(img) == LIMIT
out.write_bytes(img)
print(f"{out}: {len(img)} bytes, sha256 {hashlib.sha256(img).hexdigest()}")
print(f"  bench {len(bench)} bytes at 0x{0x08100000 + OFF:08x}; Retro-Go part unchanged")
