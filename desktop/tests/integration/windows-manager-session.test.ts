import { test, expect } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startManagerSessionServer } from "../../src/core/manager-session-server";
import type { SessionController } from "../../src/core/session-controller";
import { openManagerDirectory } from "../../src/core/manager-endpoints";
import {
  connectManagerEndpoint,
  readWindowsEndpoint,
} from "../../src/core/windows-manager-transport";

const run = promisify(execFile);
test.runIf(process.platform === "win32")(
  "Windows ACL discovery interoperates with real Python RPC, rejects foreign grants, and retires descriptors",
  async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "gnw-win-manager-"));
    const directory = join(sandbox, "private");
    const sessionId = randomUUID();
    const controller = Object.assign(new EventEmitter(), {
      managerSession: () => ({
        sessionId,
        profileName: "Windows fixture",
        model: "zelda",
        kernel: "gwemu",
        execution: "paused",
        powered: true,
        capabilities: ["manage", "gdb", "backup", "device-control"],
      }),
    }) as unknown as SessionController;
    const service = await startManagerSessionServer({ controller, directory });
    try {
      const py = process.env.GNWMANAGER_PYTHON ?? resolve("../build/windows-python/Scripts/python.exe");
      const code =
        "import json,sys; from gnwmanager.session_client import discover_sessions; print(json.dumps([s.session for s in discover_sessions(directory=sys.argv[1],timeout=5)]))";
      const result = await run(py, ["-c", code, directory], {
        env: { ...process.env, PYTHONPATH: resolve("../externals/gnwmanager") },
        timeout: 30000,
      });
      expect(JSON.parse(result.stdout)).toMatchObject([
        { sessionId, profileName: "Windows fixture" },
      ]);
      const credential = await readWindowsEndpoint(service.descriptor.endpoint);
      expect(credential.port).toBeGreaterThan(0);
      await writeFile(
        service.descriptor.endpoint,
        JSON.stringify({ ...credential, pid: credential.pid === 1 ? 2 : 1 }),
      );
      await expect(
        connectManagerEndpoint(service.descriptor.endpoint),
      ).rejects.toMatchObject({ code: "STALE_SESSION" });
      await writeFile(service.descriptor.endpoint, JSON.stringify(credential));
      const socket = await connectManagerEndpoint(service.descriptor.endpoint);
      socket.destroy();
      await run("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)R"]);
      await expect(openManagerDirectory({ directory })).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
      await run("icacls.exe", [directory, "/remove:g", "*S-1-1-0"]);
    } finally {
      await service.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  },
  60000,
);

test.runIf(process.platform === "win32")(
  "Windows Python GDB lease crosses authenticated proxies and releases the same owner",
  async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "gnw-win-gdb-"));
    const privatePath = join(sandbox, "private");
    const directory = await openManagerDirectory({ directory: privatePath });
    const endpoint = await directory.socket("lease");
    const { listenAuthenticatedLoopback } =
      await import("../../src/core/windows-manager-transport");
    const native = await listenAuthenticatedLoopback(
      endpoint.credential!.token,
      (socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          for (;;) {
            const start = buffer.indexOf("$");
            const end = buffer.indexOf("#", start);
            if (start < 0 || end < 0 || buffer.length < end + 3) return;
            const command = buffer.slice(start + 1, end);
            buffer = buffer.slice(end + 3);
            const reply = command.startsWith("qSupported")
              ? "PacketSize=1000"
              : command.startsWith("m")
                ? "78563412"
                : "";
            const checksum =
              [...Buffer.from(reply)].reduce((a, b) => a + b, 0) & 255;
            socket.write(
              `+$${reply}#${checksum.toString(16).padStart(2, "0")}`,
            );
          }
        });
      },
    );
    await endpoint.bind!((native.address() as { port: number }).port);
    const sessionId = randomUUID();
    const session = {
      sessionId,
      profileName: "Windows GDB fixture",
      model: "zelda",
      kernel: "gwemu",
      execution: "paused",
      powered: true,
      capabilities: ["manage", "gdb", "backup", "device-control"],
    };
    const completions: unknown[] = [];
    const controller = Object.assign(new EventEmitter(), {
      managerSession: () => session,
      beginManager: async () => ({
        gdbEndpoint: endpoint.path,
        initial: {
          execution: "paused",
          devicePower: {
            battery: 100,
            batteryPresent: true,
            usbPower: false,
            powered: true,
          },
        },
      }),
      markManager: async () => ({ session }),
      endManager: async (_owner: unknown, completion: unknown) => {
        completions.push(completion);
        return { session };
      },
    }) as unknown as SessionController;
    const service = await startManagerSessionServer({
      controller,
      directory: privatePath,
    });
    try {
      const py = process.env.GNWMANAGER_PYTHON ?? resolve("../build/windows-python/Scripts/python.exe");
      const code = `import json,sys
from types import SimpleNamespace
from gnwmanager.session_client import discover_sessions,SessionClient
from gnwmanager.cli.session_route import SessionGDBBackend
item=discover_sessions(directory=sys.argv[1],timeout=5)[0]
with SessionClient(item.descriptor,directory=sys.argv[1]) as client:
 lease=client.acquire(item.session['sessionId'],operation='read',timeout_ms=30000)
 backend=SessionGDBBackend(lease,SimpleNamespace(_gnw=None))
 backend.open()
 print(backend.read_memory(0x20000000,4).hex(),flush=True)
 backend.close()
 lease.release(success=True)
`;
      const result = await run(py, ["-c", code, privatePath], {
        env: { ...process.env, PYTHONPATH: resolve("../externals/gnwmanager") },
        timeout: 60000,
      });
      expect(result.stdout.trim()).toBe("78563412");
      expect(completions).toMatchObject([{ success: true }]);
    } finally {
      await service.close();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await endpoint.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  },
  90000,
);
