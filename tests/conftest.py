import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness.gnw import FIRMWARE, QEMU  # noqa: E402

GOLDEN = Path(__file__).with_name("golden.json")


def have_firmware(model):
    return (FIRMWARE / f"internal_flash_backup_{model}.bin").exists() and \
           (FIRMWARE / f"flash_backup_{model}.bin").exists()


def pytest_collection_modifyitems(config, items):
    if not QEMU.exists():
        skip = pytest.mark.skip(reason="build/qemu-system-arm missing, run scripts/build.sh")
        for item in items:
            item.add_marker(skip)


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
