import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capabilities from "../../src/core/gwemu-capabilities";
async function fixture(mode: string) {
  const d = await mkdtemp(join(tmpdir(), "gwemu-capabilities-"));
  const binary = join(d, "probe");
  const trace = join(d, "args.jsonl");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst net = require('node:net'), fs = require('node:fs');
const mode = ${JSON.stringify(mode)}, args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args)+'\\n');
const endpoint = args[args.indexOf('-qmp')+1]; const port = Number(endpoint.match(/:(\\d+),/)[1]);
const s = net.connect(port,'127.0.0.1',()=>s.write(JSON.stringify({QMP:{}})+'\\n'));
let buffer=''; s.on('data',chunk=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\\n'))>=0){const q=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1); let r={}; const p=q.arguments?.property;
if(q.execute==='qom-list-properties'){r=[['instant-states','bool'],['state-id','string'],['savestate-support','string'],['save-state','string'],['load-state','string']].map(([name,type])=>({name,type})); if(mode==='wrong-type')r.find(p=>p.name==='load-state').type='bool'; if(mode==='missing')r.pop();}
else if(q.execute==='qom-get'){if(p==='savestate-support')r=mode==='null'?null:mode==='false'?false:mode==='zero'?0:mode==='object'?{}:['disabled','timing','unknown'].includes(mode)?mode:'';else if(mode==='readable')r='';else{ s.write(JSON.stringify({id:q.id,error:{desc:'Property is not readable'}})+'\\n');continue;}}
else if(q.execute==='qom-set'){let desc=p==='savestate-support'?'Property is not writable':'State path must be absolute';if(mode==='writable'&&p==='savestate-support')r={};else{ s.write(JSON.stringify({id:q.id,error:{desc}})+'\\n');continue;}}
s.write(JSON.stringify({id:q.id,return:r})+'\\n');if(q.execute==='quit')setTimeout(()=>process.exit(0),5); }});
`,
    { mode: 0o755 },
  );
  return { d, binary, trace };
}
test("capability preflight checks class types and nonmutating access without ROM paths", async () => {
  expect((capabilities as any).requireSavestateCapabilities).toBeTypeOf(
    "function",
  );
  const f = await fixture("good");
  try {
    await (capabilities as any).requireSavestateCapabilities(
      f.binary,
      process.env,
    );
    const args = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(args).toHaveLength(2);
    expect(args[0][1]).toBe("none");
    expect(args[1][1]).toContain("instant-states=on,state-id=");
    expect(
      args
        .flat()
        .some((v: string) =>
          /image=|session-lock=|frame-endpoint=|^-drive$/.test(v),
        ),
    ).toBe(false);
  } finally {
    await rm(f.d, { recursive: true, force: true });
  }
});
test.each([
  "wrong-type",
  "missing",
  "readable",
  "writable",
  "null",
  "false",
  "zero",
  "object",
  "disabled",
  "timing",
  "unknown",
])("capability %s fails closed", async (mode) => {
  expect((capabilities as any).requireSavestateCapabilities).toBeTypeOf(
    "function",
  );
  const f = await fixture(mode);
  try {
    await expect(
      (capabilities as any).requireSavestateCapabilities(f.binary, process.env),
    ).rejects.toMatchObject({ code: "error.kernelBuild" });
  } finally {
    await rm(f.d, { recursive: true, force: true });
  }
});
