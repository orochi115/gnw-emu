"""OTFDEC AES-CTR helper for offline analysis and tests.

Port of game-and-watch-patch/patches/firmware.py:crypt(). The key and nonce
are read from the internal flash image at runtime; they are never stored here.
"""
import argparse
from Crypto.Cipher import AES

FLASH_BASE = 0x90000000

MODELS = {
    # key offset, nonce offset, encrypted range (file offsets)
    "zelda": dict(key=0x165A4, nonce=0x16590, start=0x20000, end=0x3254A0),
    "mario": dict(key=0x106F4, nonce=0x106E4, start=0x00000, end=0xFE000),
}


def detect(internal: bytes) -> str:
    return "zelda" if len(internal) and b"Link" in internal else "mario"


def keystream_block(aes, iv: bytes, addr: int) -> bytes:
    cb = bytearray(iv)
    counter = addr >> 4
    cb[12] = ((counter >> 24) & 0x0F) | (cb[12] & 0xF0)
    cb[13] = (counter >> 16) & 0xFF
    cb[14] = (counter >> 8) & 0xFF
    cb[15] = counter & 0xFF
    return aes.encrypt(bytes(cb))[::-1]


def crypt(internal: bytes, external: bytes, model: str) -> bytes:
    m = MODELS[model]
    key = internal[m["key"]:m["key"] + 16][::-1]
    nonce = internal[m["nonce"]:m["nonce"] + 8][::-1]
    iv = nonce + b"\x00\x00\x71\x23\x20\x00\x00\x00"
    aes = AES.new(key, AES.MODE_ECB)
    out = bytearray(external)
    end = min(m["end"], len(out))
    for off in range(m["start"], end, 16):
        ks = keystream_block(aes, iv, FLASH_BASE + off)
        for i in range(min(16, end - off)):
            out[off + i] ^= ks[i]
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("internal")
    ap.add_argument("external")
    ap.add_argument("out")
    ap.add_argument("--model", choices=MODELS)
    a = ap.parse_args()
    internal = open(a.internal, "rb").read()
    external = open(a.external, "rb").read()
    model = a.model or ("zelda" if len(external) > 0x100000 else "mario")
    open(a.out, "wb").write(crypt(internal, external, model))


if __name__ == "__main__":
    main()
