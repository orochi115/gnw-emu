"""Staging must use the pinned clean native build, with verifiable provenance."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build/gwemu'


def validate(binary, manifest):
    script = """import { validateNativeSource } from './desktop/tools/native-stage-manifest.mjs';
const result = await validateNativeSource(process.argv[1], process.argv[2]);
console.log(JSON.stringify(result));"""
    return subprocess.run(['node', '--input-type=module', '-e', script,
                           str(binary), str(manifest)], cwd=ROOT, text=True,
                          capture_output=True, timeout=15)


def test_pinned_clean_build_is_accepted_without_modifying_source():
    binary = BUILD / 'qemu-system-arm'
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    result = validate(binary, BUILD / 'gnw-build-manifest.json')
    assert result.returncode == 0, result.stderr
    checked = json.loads(result.stdout)
    assert checked['sourceSha256'] == digest
    assert checked['revision'] == 'a38484468d947ce6447fcc7dec47ebeef041f853'
    assert checked['capabilities']['gdb'] is True
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == digest


@pytest.mark.parametrize('invalid', ['missing', 'dirty', 'revision', 'artifact-hash'])
def test_staging_rejects_unverified_native_provenance(tmp_path, invalid):
    manifest = tmp_path / 'manifest.json'
    content = json.loads((BUILD / 'gnw-build-manifest.json').read_text())
    if invalid != 'missing':
        if invalid == 'dirty':
            content['sourceDirty'] = True
        elif invalid == 'revision':
            content['revision'] = '0' * 40
        elif invalid == 'artifact-hash':
            content['artifact']['sha256'] = '0' * 64
        manifest.write_text(json.dumps(content))
    result = validate(BUILD / 'qemu-system-arm', manifest)
    assert result.returncode != 0
    assert 'Cannot stage gwemu' in result.stderr
