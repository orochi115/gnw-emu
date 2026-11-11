import json
import hashlib
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from harness.gnw import GnW

with GnW('zelda', deterministic=True) as gw:
    gw.run(200)
    result = {'qemu': gw.qmp.cmd('query-version'), 'pc': hex(gw.pc)}
    addresses = {'ospi_cr': 0x52005000, 'ltdc_gcr': 0x50001018, 'dac1_cr': 0x40007400, 'rcc_cr': 0x58024400}
    result['source_mmio'] = {name: gw.read_mem(addr, 4).hex() for name, addr in addresses.items()}
    ram = gw.read_mem(0x20000000, 128 * 1024)
    result['source_dtcm_sha256'] = hashlib.sha256(ram).hexdigest()
    result['source_dtcm_nonzero_bytes'] = sum(value != 0 for value in ram)
    result['savevm'] = gw.hmp('savevm feasibility')
    result['ramblocks'] = gw.hmp('info ramblock')
    target = gw.tmp / 'state.bin'
    start = time.monotonic()
    gw.qmp.cmd('migrate', uri='file:' + str(target))
    for _ in range(200):
        status = gw.qmp.cmd('query-migrate')
        if status.get('status') in ('completed', 'failed', 'cancelled'):
            break
        time.sleep(0.025)
    result['migration'] = status
    result['elapsed_seconds'] = round(time.monotonic() - start, 3)
    result['state_bytes'] = target.stat().st_size if target.exists() else None
    if target.exists():
        raw = target.read_bytes()
        marker = raw.rfind(b'{"page_size"')
        if marker >= 0:
            desc = json.JSONDecoder().raw_decode(raw[marker:].decode('utf-8', errors='replace'))[0]
            result['serialized_devices'] = [d['name'] for d in desc['devices']]
        if marker < 0:
            import re
            result['serialized_devices'] = re.findall(r'"name"\s*:\s*"([^"]+)"\s*,\s*"instance_id"', raw[-30000:].decode('utf-8', errors='replace'))
        with GnW('zelda', deterministic=True, extra=['-incoming', 'defer']) as restored:
            restored.qmp.cmd('migrate-incoming', uri='file:' + str(target))
            for _ in range(200):
                incoming = restored.qmp.cmd('query-status')
                if incoming.get('status') != 'inmigrate':
                    break
                time.sleep(0.025)
            result['restore_status'] = incoming
            result['restored_pc'] = hex(restored.pc)
            result['restored_mmio'] = {name: restored.read_mem(addr, 4).hex() for name, addr in addresses.items()}
            result['restored_dtcm_matches'] = hashlib.sha256(restored.read_mem(0x20000000, 128 * 1024)).hexdigest() == result['source_dtcm_sha256']
    output = json.dumps(result, indent=2)
    Path('/private/tmp/gnw-savestate-probe-result.json').write_text(output + '\n')
    print(output)
