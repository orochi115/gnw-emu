"""CRYP DATATYPE applies to the data FIFO, independently of key registers."""
import pytest

from test_gwemu_desktop import Native, GWEMU

pytestmark = pytest.mark.skipif(not GWEMU.exists(), reason="build gwemu first")
C = 0x48021000


def swap(word, datatype):
    if datatype == 1:
        return ((word << 16) | (word >> 16)) & 0xffffffff
    if datatype == 2:
        return int.from_bytes(word.to_bytes(4, "big"), "little")
    if datatype == 3:
        return int(f"{word:032b}"[::-1], 2)
    return word


# FIPS-197 Appendix C AES known-answer vectors; no emulator-derived oracle.
@pytest.mark.parametrize("key,cipher", [
    ("000102030405060708090a0b0c0d0e0f", "69c4e0d86a7b0430d8cdb78070b4c55a"),
    ("000102030405060708090a0b0c0d0e0f1011121314151617", "dda97ca4864cdfe06eaf70a0ec0d7191"),
    ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
     "8ea2b7ca516745bfeafc49904b496089"),
])
@pytest.mark.parametrize("datatype", range(4))
@pytest.mark.parametrize("decrypt", (False, True))
def test_aes_fifo_datatype_known_answer(tmp_path, key, cipher, datatype, decrypt):
    key = bytes.fromhex(key)
    plain = bytes.fromhex("00112233445566778899aabbccddeeff")
    cipher = bytes.fromhex(cipher)
    source, expected = (cipher, plain) if decrypt else (plain, cipher)
    with Native(tmp_path) as n:
        for index in range(len(key) // 4):
            n.write32(C + 0x20 + 32 - len(key) + index * 4,
                      int.from_bytes(key[index * 4:index * 4 + 4], "big"))
        cr = 0x20 | ((len(key) // 8 - 2) << 8) | (datatype << 6) | (int(decrypt) << 2)
        n.write32(C, cr | 0x8000)
        for offset in range(0, 16, 4):
            n.write32(C + 8, swap(int.from_bytes(source[offset:offset + 4], "big"), datatype))
        result = b"".join(swap(n.read32(C + 0xc), datatype).to_bytes(4, "big")
                          for _ in range(4))
        assert result == expected


@pytest.mark.parametrize("datatype", range(4))
@pytest.mark.parametrize("decrypt", (False, True))
def test_gcm_final_length_is_unswapped_on_h7_rev_b(tmp_path, datatype, decrypt):
    # NIST SP800-38D: zero 128-bit key, 96-bit nonce, one zero block, no AAD.
    plain = bytes(16)
    cipher = bytes.fromhex("0388dace60b6a392f328c2b971b2fe78")
    tag = bytes.fromhex("ab6e47d42cec13bdf53a67b21257bddf")
    source, expected = (cipher, plain) if decrypt else (plain, cipher)
    with Native(tmp_path) as n:
        n.write32(C + 0x4c, 2)  # J0+1, independent of DATATYPE.
        cr = 0x80000 | (datatype << 6) | (int(decrypt) << 2)
        n.write32(C, cr | 0x8000)
        assert n.read32(C) & 0x8000 == 0
        n.write32(C, cr | 0x28000)
        for offset in range(0, 16, 4):
            n.write32(C + 8, swap(int.from_bytes(source[offset:offset + 4], "big"), datatype))
        result = b"".join(swap(n.read32(C + 0xc), datatype).to_bytes(4, "big")
                          for _ in range(4))
        assert result == expected
        n.write32(C, cr | 0x20000)
        n.write32(C, (cr & ~4) | 0x38000)
        # STM32 HAL explicitly bypasses DATATYPE for FINAL lengths on rev.B+.
        for word in (0, 0, 0, 128):
            n.write32(C + 8, word)
        result_tag = b"".join(swap(n.read32(C + 0xc), datatype).to_bytes(4, "big")
                              for _ in range(4))
        assert result_tag == tag
