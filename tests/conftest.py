import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness.assets import FIRMWARE  # noqa: E402

GOLDEN = Path(__file__).with_name("golden.json")


def have_firmware(model):
    return (FIRMWARE / f"internal_flash_backup_{model}.bin").exists() and \
           (FIRMWARE / f"flash_backup_{model}.bin").exists()


@pytest.fixture
def golden():
    """Compare frame hashes with tests/golden.json.

    Frames are only reproducible with deterministic=True. Set
    GNW_UPDATE_GOLDEN=1 to record new values after an intended change.
    The repository stores hashes only, never screen contents.
    """
    data = json.loads(GOLDEN.read_text()) if GOLDEN.exists() else {}
    update = os.environ.get("GNW_UPDATE_GOLDEN") == "1"

    def check(name, image):
        digest = hashlib.sha1(image.convert("RGB").tobytes()).hexdigest()
        if update or name not in data:
            data[name] = digest
            GOLDEN.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        else:
            assert digest == data[name], f"frame {name} changed"

    return check


@pytest.fixture
def check_brightness_menu():
    """Check firmware key handling, DAC conversion and displayed intensity."""
    from PIL import ImageStat

    def check(gw, crop):
        def sample():
            value = int(gw.hmp("xp /1wx 0x4000742c").split()[-1], 16)
            strength = sum(ImageStat.Stat(gw.frame().crop(crop)).mean)
            return value, strength

        # Start at the brightest setting so this also works with saved
        # settings at the minimum. Both firmware families have <=10 levels.
        for _ in range(10):
            gw.press("right", 100, 150)
        high, high_strength = sample()
        previous, previous_strength = high, high_strength
        changes = 0
        for _ in range(10):
            gw.press("left", 100, 150)
            low, low_strength = sample()
            if low == previous:
                break  # minimum reached
            assert 0 < low < previous <= 4095
            assert 0 < low_strength < previous_strength
            previous, previous_strength = low, low_strength
            changes += 1
        assert changes > 0
        for _ in range(10):
            gw.press("right", 100, 150)
        restored, restored_strength = sample()
        assert restored == high
        assert abs(restored_strength - high_strength) < 0.5

    return check
