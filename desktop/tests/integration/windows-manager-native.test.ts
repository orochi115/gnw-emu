import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { SessionController } from "../../src/core/session-controller";
import { startManagerSessionServer } from "../../src/core/manager-session-server";
import { createLogManager } from "../../src/observability/logger";
import { createDisplayReceiver } from "../../src/display/receiver";
import { loadProfile } from "../../src/core/profile-store";
const run = promisify(execFile);
const enabled =
  process.platform === "win32" && process.env.GWEMU_WINDOWS_INTEGRATION === "1";
test.runIf(enabled)(
  "Windows native session supports Python leased GDB and preserves source images",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gnw-win-native-"));
    const profilePath = resolve(
      process.env.GWEMU_WINDOWS_PROFILE ?? "../profiles/windows-mario.gnw.json",
    );
    const profile = await loadProfile(profilePath);
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    const hashes = await Promise.all([
      hash(profile.internalFlash),
      hash(profile.externalFlash),
    ]);
    const controller = new SessionController({
      kernel: "gwemu",
      qemu: resolve(
        process.env.GWEMU_BINARY ?? "../build/gwemu/qemu-system-arm.exe",
      ),
      userData: join(root, "data"),
      managerDirectory: join(root, "private"),
      timeout: 20000,
      logger: createLogManager({
        appInstanceId: "windows-manager-native",
        destination: new Writable({
          write(_c, _e, done) {
            done();
          },
        }),
      }).child("session"),
      createDisplay: () => createDisplayReceiver(() => {}),
    });
    const service = await startManagerSessionServer({
      controller,
      directory: join(root, "private"),
    });
    try {
      await controller.load(profilePath);
      expect(controller.state.status).toBe("running");
      const py =
        process.env.GNWMANAGER_PYTHON ??
        "../build/windows-python/Scripts/python.exe";
      const code = `import json,sys
from types import SimpleNamespace
from gnwmanager.session_client import discover_sessions,SessionClient
from gnwmanager.cli.session_route import SessionGDBBackend
item=discover_sessions(directory=sys.argv[1],timeout=5)[0]
with SessionClient(item.descriptor,directory=sys.argv[1]) as client:
 lease=client.acquire(item.session['sessionId'],operation='read',timeout_ms=60000)
 backend=SessionGDBBackend(lease,SimpleNamespace(_gnw=None))
 backend.open()
 memory=backend.read_memory(0x20000000,4)
 pc=backend.read_register('pc')
 backend.close()
 lease.release(success=True)
 print(json.dumps({'sessionId':item.session['sessionId'],'pc':pc,'bytes':len(memory)}))
`;
      const result = await run(py, ["-c", code, join(root, "private")], {
        env: { ...process.env, PYTHONPATH: resolve("../externals/gnwmanager") },
        timeout: 90000,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        sessionId: controller.state.runtimeSessionId,
        bytes: 4,
      });
      expect(Number.isInteger(JSON.parse(result.stdout).pc)).toBe(true);
      expect(controller.state.execution).toBe("running");
    } finally {
      await service.close();
      await controller.stop();
      expect(
        await Promise.all([
          hash(profile.internalFlash),
          hash(profile.externalFlash),
        ]),
      ).toEqual(hashes);
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
