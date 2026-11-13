"""Input asset locations shared by native software fixtures."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIRMWARE = ROOT.parent / "firmware"
