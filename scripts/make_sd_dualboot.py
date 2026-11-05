#!/usr/bin/env python3
"""Assemble the flash images of a Retro-Go SD dual-boot install.

What `gnwmanager flash-patch zelda ... --bootloader` writes to a device:
  bank 1   = stock firmware patched with --sd-bootloader (0x32000 bytes,
             from game-and-watch-patch build/internal_flash_patched.bin)
             followed by gnw_bootloader_0x08032000.bin (sylverb's SD
             bootloader, see scripts/fetch_cores.sh)
  external = build/external_flash_patched.bin, padded with 0xff to the
             size of the fitted chip (64 MiB MX25U51245G by default)
Bank 2 starts erased; the bootloader installs Retro-Go there from
retro-go_update.bin on the SD card.

  scripts/make_sd_dualboot.py --patch ../gnw-patch-sd/build out/sd/dualboot
"""
import argparse
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOTLOADER_OFFSET = 0x32000


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", help="output directory (bank1.bin, ext.bin)")
    ap.add_argument("--patch", required=True,
                    help="game-and-watch-patch build/ directory (--sd-bootloader)")
    ap.add_argument("--bootloader",
                    default=str(ROOT / "out/dl/bootloader/gnw_bootloader_0x08032000.bin"))
    ap.add_argument("--ext-mb", type=int, default=64)
    args = ap.parse_args()

    patch = pathlib.Path(args.patch)
    internal = (patch / "internal_flash_patched.bin").read_bytes()
    if len(internal) != BOOTLOADER_OFFSET:
        raise SystemExit(f"internal image is {len(internal):#x} bytes, expected "
                         f"{BOOTLOADER_OFFSET:#x}: was it patched with --sd-bootloader?")
    bank1 = internal + pathlib.Path(args.bootloader).read_bytes()
    if len(bank1) > 256 * 1024:
        raise SystemExit("bootloader does not fit in bank 1")
    bank1 += b"\xff" * (256 * 1024 - len(bank1))

    ext = (patch / "external_flash_patched.bin").read_bytes()
    size = args.ext_mb * 1024 * 1024
    if len(ext) > size:
        raise SystemExit("external image larger than --ext-mb")
    ext += b"\xff" * (size - len(ext))

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "bank1.bin").write_bytes(bank1)
    (out / "ext.bin").write_bytes(ext)
    print(f"{out}/bank1.bin (bootloader at 0x08032000), {out}/ext.bin ({args.ext_mb} MiB)")


if __name__ == "__main__":
    main()
