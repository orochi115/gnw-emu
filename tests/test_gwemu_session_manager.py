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
    result = {}
    for name in ("cli-source-v2.json", "client-source-v4.json"):
        frozen = json.loads((OUT / name).read_text())
        for relative, expected in frozen["files"].items():
            path = ROOT / "externals/gnwmanager" / relative
            assert digest(path) == expected, str(path)
            result[str(path)] = expected
    for relative, expected in json.loads((OUT / "failed-release-source.json").read_text())["files"].items():
        path = ROOT / relative
        assert digest(path) == expected, str(path)
        result[str(path)] = expected
    return result


def test_real_electron_public_manager_workflows():
    before = frozen_sources()
    report = OUT / "manager-workflow-playwright.json"
    env = {**os.environ, "PLAYWRIGHT_JSON_OUTPUT_NAME": str(report)}
    # A fresh build must be made before invoking this bridge; it does not mutate
    # production source or build historical/native firmware artifacts itself.
    result = subprocess.run(
        ["npm", "run", "test:e2e", "--", "tests/e2e/gwemu-manager.spec.ts", "--reporter=list,json"],
        cwd=ROOT / "desktop", env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=900,
    )
    (OUT / "manager-workflow-final.log").write_text(result.stdout)
    assert frozen_sources() == before
    assert result.returncode == 0, result.stdout
    data = json.loads(report.read_text())
    assert data["stats"]["expected"] == 13, data["stats"]
    assert data["stats"]["unexpected"] == 0, data["stats"]
    assert data["stats"]["flaky"] == 0, data["stats"]
    assert data["stats"]["skipped"] == 0, data["stats"]
    for path in (OUT / "manager-workflow").glob("*.json"):
        evidence = json.loads(path.read_text())
        if "commands" not in evidence:
            continue
        for field in ("remainingNativePids", "remainingOwnedPids", "remainingClientPids", "remainingEndpoints"):
            assert evidence[field] == [], (str(path), field, evidence[field])
