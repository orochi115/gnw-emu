#!/usr/bin/env python3
"""Guard an independent build directory and record its actual provenance."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    action, source, build, *flags = sys.argv[1:]
    source, build = Path(source).resolve(), Path(build).resolve()
    revision = run('git', '-C', str(source), 'rev-parse', 'HEAD')
    signature = {
        'source': str(source), 'revision': revision, 'configureArgs': flags,
        'python': str(Path(sys.executable).resolve()),
        'environment': {key: os.environ.get(key) for key in
                        ('CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG',
                         'PKG_CONFIG_PATH', 'GNW_ALLOW_NO_GUI')},
    }
    config = build / 'gnw-build-config.json'
    if action == 'check':
        if (build / 'build.ninja').exists():
            if not config.exists() or json.loads(config.read_text()) != signature:
                sys.exit('Build source/revision/configuration changed; choose a fresh '
                         'GWEMU_BUILD_DIR. Existing output was not modified.')
    elif action == 'configured':
        config.write_text(json.dumps(signature, indent=2) + '\n')
    elif action == 'record':
        binary = build / 'qemu-system-arm'
        tools = {}
        for name, args in [('compiler', [os.environ.get('CC', 'cc'), '--version']),
                           ('ninja', ['ninja', '--version']),
                           ('cmake', ['cmake', '--version']),
                           ('pkg-config', [os.environ.get('PKG_CONFIG', 'pkg-config'), '--version'])]:
            try:
                tools[name] = {'path': shutil.which(args[0]), 'version': run(*args)}
            except (OSError, subprocess.CalledProcessError) as error:
                tools[name] = {'error': str(error)}
        manifest = {
            **signature, 'formatVersion': 1,
            'sourceDirty': bool(run('git', '-C', str(source), 'status', '--porcelain',
                                   '--untracked-files=no')),
            'trackedDiffSha256': hashlib.sha256(run('git', '-C', str(source), 'diff',
                                                   'HEAD').encode()).hexdigest(),
            'host': {'system': platform.system(), 'architecture': platform.machine(),
                     'release': platform.release(), 'pythonVersion': platform.python_version()},
            'tools': tools,
            'migrationPatches': [
                {'file': patch.name, 'sha256': digest(patch)}
                for patch in sorted((Path(__file__).resolve().parent.parent /
                                     'patches' / 'gwemu').glob('*.patch'))
            ],
            'artifact': {'path': str(binary), 'sha256': digest(binary),
                         'version': run(str(binary), '-display', 'none', '--version')},
        }
        # Meson records actual selected compilers/dependency/subproject versions.
        for kind in ('compilers', 'dependencies', 'buildoptions', 'projectinfo'):
            info = build / 'meson-info' / f'intro-{kind}.json'
            if info.exists():
                manifest[kind] = json.loads(info.read_text())
        (build / 'gnw-build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(f'gwemu {revision}: {binary}\nSHA-256 {manifest["artifact"]["sha256"]}')
    else:
        sys.exit(f'Unknown action: {action}')


if __name__ == '__main__':
    main()
