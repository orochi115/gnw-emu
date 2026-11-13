"""Required Electron/public-CLI acceptance, run once through the Playwright suite.

This is a pytest runner bridge, not a second simulated integration test. Missing
tools, local firmware, or a GUI fail this acceptance instead of adding skips.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "out/gwemu-completion"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def frozen_sources():
    # Snapshot current maintained production sources. Task3 legitimately changed
    # the controller, so historical Task6 hashes are not the current acceptance.
    paths = [*ROOT.joinpath("desktop/src").rglob("*.ts"),
             *ROOT.joinpath("desktop/src").rglob("*.tsx"),
             *ROOT.joinpath("externals/gnwmanager/gnwmanager").rglob("*.py")]
    return {str(path): digest(path) for path in sorted(paths)}


def test_real_electron_public_manager_workflows():
    before = frozen_sources()
    report = OUT / "product-final-manager-playwright.json"
    env = {**os.environ, "PLAYWRIGHT_JSON_OUTPUT_NAME": str(report)}
    # A fresh build must be made before invoking this bridge; it does not mutate
    # production source or build historical/native firmware artifacts itself.
    result = subprocess.run(
        ["npm", "run", "test:e2e", "--", "tests/e2e/gwemu-manager.spec.ts", "--reporter=list,json"],
        cwd=ROOT / "desktop", env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=900,
    )
    (OUT / "product-final-manager.log").write_text(result.stdout)
    assert frozen_sources() == before
    assert result.returncode == 0, result.stdout
    data = json.loads(report.read_text())
    assert data["stats"]["expected"] == 13, data["stats"]
    assert data["stats"]["unexpected"] == 0, data["stats"]
    assert data["stats"]["flaky"] == 0, data["stats"]
    assert data["stats"]["skipped"] == 0, data["stats"]
    for path in (OUT / "product-final-manager").glob("*.json"):
        evidence = json.loads(path.read_text())
        if "commands" not in evidence:
            continue
        for field in ("remainingNativePids", "remainingOwnedPids", "remainingClientPids", "remainingEndpoints"):
            assert evidence[field] == [], (str(path), field, evidence[field])
