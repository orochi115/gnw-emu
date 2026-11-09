"""Exercise real profile creation; intercept only the final GUI process launch."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import uuid

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]

@pytest.fixture
def launch_tree(tmp_path):
    workspace = tmp_path / 'workspace with spaces'
    repo = workspace / 'emulator app'
    assets = workspace / 'prepared assets'
    dump = workspace / 'dump firmware'
    for directory in (repo / 'scripts', repo / 'profiles', repo / 'desktop/dist-cli', repo / 'desktop/out/main', repo / 'build', assets, dump):
        directory.mkdir(parents=True, exist_ok=True)
    for script in ROOT.joinpath('scripts').glob('*.sh'):
        shutil.copy2(script, repo / 'scripts' / script.name)
    shutil.copy2(ROOT / 'desktop/dist-cli/cli.js', repo / 'desktop/dist-cli/cli.js')
    (repo / 'desktop/node_modules').symlink_to(ROOT / 'desktop/node_modules', target_is_directory=True)
    (repo / 'desktop/package.json').write_text('{"type":"module"}')
    (repo / 'desktop/out/main/index.js').write_text('// already built')
    (repo / 'build/qemu-system-arm').write_text('#!/bin/sh\nexit 0\n')
    (repo / 'build/qemu-system-arm').chmod(0o755)
    for name in ('bank1.bin', 'bank2.bin', 'ext.bin'):
        (dump / name).write_bytes(bytes(256 * 1024 if name=='bank1.bin' else 1024))
    firmware = workspace / 'firmware'
    firmware.mkdir()
    for model in ('zelda', 'mario'):
        internal = firmware / f'internal_flash_backup_{model}.bin'
        external = firmware / f'flash_backup_{model}.bin'
        internal.write_bytes(bytes(256 * 1024)); external.write_bytes(bytes(1024))
        (repo / 'profiles' / f'{model}.gnw.json').write_text(json.dumps(dict(formatVersion=1,id=str(uuid.uuid4()),model=model,internalFlash=str(internal),externalFlash=str(external))))
    for relative in ('externals/retro-go-sd/build/gw_retro_go_intflash.bin', 'externals/retro-go-sd/release/retro-go_update.bin', 'out/dl/test/x/cores/test.bin', 'out/sd/sdcard.img', 'out/sd/update/card.img', 'out/sd/dualboot/bank1.bin', 'out/sd/dualboot/ext.bin'):
        file = assets / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'fixture' * 128)
    fakebin = tmp_path / 'bin'; fakebin.mkdir()
    node = shutil.which('node')
    capture = tmp_path / 'launch.json'
    (fakebin / 'node').write_text('''#!/usr/bin/env python3
import os,sys,json
if len(sys.argv)>2 and sys.argv[2]=='launch':
    open(os.environ['CAPTURE'], 'w').write(json.dumps(sys.argv[1:]))
else:
    os.execv(os.environ['REAL_NODE'], [os.environ['REAL_NODE'], *sys.argv[1:]])
''')
    (fakebin / 'node').chmod(0o755)
    env = {**{k:os.environ[k] for k in ("PATH","LANG","TMPDIR") if k in os.environ}, 'PATH':str(fakebin)+os.pathsep+os.environ['PATH'], 'REAL_NODE':node, 'CAPTURE':str(capture), 'GNW_ASSET_DIR':str(assets), 'GNW_BACKUP_DIR':str(dump)}
    return repo, assets, dump, capture, env

@pytest.mark.parametrize('script,args', [('run.sh',['mario']), ('run_backup.sh',[]), ('run_sd.sh',[]), ('run_sd_update.sh',[])])
def test_one_command_launch_preserves_flags_and_source_images(launch_tree, tmp_path, script, args):
    repo, assets, dump, capture, env = launch_tree
    sources = [*dump.glob('*.bin'), *assets.rglob('*.img')]
    before = {str(p):hashlib.sha256(p.read_bytes()).digest() for p in sources}
    flags = ['--language=en', '--automation', '--user-data-dir='+str(tmp_path / 'isolated saves')]
    result = subprocess.run([str(repo/'scripts'/script), *args, *flags], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout+result.stderr
    launched = json.loads(capture.read_text())
    assert launched[1] == 'launch'
    assert launched[3:] == flags
    profile = json.loads(pathlib.Path(launched[2]).read_text())
    assert profile['formatVersion']==1
    assert 'deviceUid' not in profile
    if script.startswith('run_sd'):
        assert profile['sdWiring']=='spi1'
        assert (pathlib.Path(launched[2]).parent/profile['sdCard']).resolve().is_file()
    assert all(hashlib.sha256(pathlib.Path(p).read_bytes()).digest()==value for p,value in before.items())


def test_dump_reuses_identity_and_fresh_preserves_previous_session(launch_tree, tmp_path):
    repo, assets, dump, capture, env = launch_tree
    command=[str(repo/'scripts/run_backup.sh'),str(dump),'--debug']
    first=subprocess.run(command,env=env,capture_output=True,text=True)
    assert first.returncode==0,first.stdout+first.stderr
    profile=pathlib.Path(json.loads(capture.read_text())[2]); old=json.loads(profile.read_text())['id']
    save=repo/'UserData/sessions'/old/'sentinel';save.parent.mkdir(parents=True);save.write_text('keep')
    assert subprocess.run(command,env=env,capture_output=True).returncode==0
    assert json.loads(profile.read_text())['id']==old
    assert subprocess.run(command,env={**env,'FRESH':'1'},capture_output=True).returncode==0
    assert json.loads(profile.read_text())['id']!=old
    assert save.read_text()=='keep'

@pytest.mark.parametrize('script,card', [('run_sd.sh','out/sd/sdcard.img'),('run_sd_update.sh','out/sd/update/card.img')])
def test_fresh_sd_never_rebuilds_an_explicit_source_card(launch_tree, script, card):
    repo, assets, dump, capture, env = launch_tree
    source = assets/card
    before = source.read_bytes()
    result = subprocess.run([str(repo/'scripts'/script),'--automation'], env={**env,'FRESH':'1','SDCARD':str(source)},capture_output=True,text=True)
    assert result.returncode == 0, result.stdout+result.stderr
    assert source.read_bytes() == before
