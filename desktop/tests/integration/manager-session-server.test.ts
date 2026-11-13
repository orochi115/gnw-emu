import { expect, test, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  lstat,
  writeFile,
  readdir,
  unlink,
  chmod,
} from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";
import { SessionController, deadline } from "../../src/core/session-controller";
import { createLogManager } from "../../src/observability/logger";

import {
  startManagerSessionServer,
  type ManagerServerOptions,
} from "../../src/core/manager-session-server";
let artifactVerified = false;
async function client(path: string) {
  const socket = createConnection({ path });
  await deadline(
    new Promise<void>((r, j) => {
      socket.once("connect", r);
      socket.once("error", j);
    }),
    1000,
    "rpc-connect",
  );
  let sequence = 0,
    buffer = "";
  const pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        p.resolve(message);
      }
    }
  });
  socket.on("error", (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  });
  socket.on("close", () => {
    for (const p of pending.values()) p.reject(new Error("RPC closed"));
    pending.clear();
  });
  return {
    socket,
    async call(method: string, params: object = {}, fragments = false) {
      const id = String(++sequence);
      const value = JSON.stringify({ protocol: 1, id, method, params }) + "\n";
      const result = new Promise<any>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      if (fragments) {
        for (const part of [
          value.slice(0, 4),
          value.slice(4, 17),
          value.slice(17),
        ])
          socket.write(part);
      } else socket.write(value);
      return deadline(result, 2000, "rpc-response");
    },
    async send(value: object, fragments?: Buffer[]) {
      const id = String(++sequence);
      const frame = Buffer.from(JSON.stringify({ ...value, id }) + "\n");
      const result = new Promise<any>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      for (const part of fragments ?? [frame]) socket.write(part);
      return deadline(result, 2000, "rpc-response");
    },
    close() {
      socket.destroy();
    },
  };
}
function emptyController(root: string) {
  return new SessionController({
    userData: join(root, "data"),
    qemu: "unused",
    kernel: "gwemu",
    logger: createLogManager({
      appInstanceId: "manager-server",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: async () => {
      throw new Error("no native without ROM");
    },
  });
}

test("private real Unix service publishes distinct identities and lists no ROM without native", async () => {
  const root = await mkdtemp("/tmp/gnw-ms-");
  const peers: Awaited<ReturnType<typeof client>>[] = [];
  const services: Awaited<ReturnType<typeof startManagerSessionServer>>[] = [];
  try {
    for (let i = 0; i < 2; i++)
      services.push(
        await startManagerSessionServer({
          controller: emptyController(root),
          directory: join(root, "private"),
        }),
      );
    expect(services[0].descriptor.serverId).not.toBe(
      services[1].descriptor.serverId,
    );
    for (const service of services) {
      expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
      expect((await lstat(service.descriptor.endpoint)).mode & 0o777).toBe(
        0o600,
      );
      expect((await lstat(service.descriptorPath)).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(await readFile(service.descriptorPath, "utf8")),
      ).toEqual(service.descriptor);
      const peer = await client(service.descriptor.endpoint);
      peers.push(peer);
      expect(
        await peer.call(
          "hello",
          { serverId: service.descriptor.serverId },
          true,
        ),
      ).toMatchObject({
        ok: true,
        result: { serverId: service.descriptor.serverId, protocol: 1 },
      });
      expect(await peer.call("list")).toMatchObject({
        ok: true,
        result: { sessions: [] },
      });
      expect(
        await peer.call("hello", {
          serverId: services.find((s) => s !== service)!.descriptor.serverId,
        }),
      ).toMatchObject({ ok: false, error: { code: "STALE_SESSION" } });
    }
  } finally {
    for (const p of peers) p.close();
    for (const s of services) await s.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function nativeFixture(options: Partial<ManagerServerOptions> = {}) {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { writeFile, readdir } = await import("node:fs/promises");
  const { createProfile } = await import("../../src/core/profile-store");
  const { createDisplayReceiver } = await import("../../src/display/receiver");
  const { vi } = await import("vitest");
  const kernel = await import("../../src/core/kernel-backend");
  const { createInterface } = await import("node:readline");
  const binary = resolve(
    "../build/gwemu-session-manager-release/qemu-system-arm",
  );
  expect(existsSync(binary), "required native is missing").toBe(true);
  if (!artifactVerified) {
    const { createHash } = await import("node:crypto");
    const manifest = JSON.parse(
      await readFile(
        resolve(
          "../build/gwemu-session-manager-release/gnw-build-manifest.json",
        ),
        "utf8",
      ),
    );
    expect(manifest.sourceDirty).toBe(false);
    expect(manifest.revision).toBe("a38484468d947ce6447fcc7dec47ebeef041f853");
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe("a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e");
    artifactVerified = true;
  }
  const root = await mkdtemp("/tmp/gnw-ms-native-");
  const directory = join(root, "private");
  const internal = Buffer.alloc(128 * 1024, 0xff),
    external = Buffer.alloc(1024 * 1024, 0x37);
  internal.writeUInt32LE(0x20010000, 0);
  internal.writeUInt32LE(0x08000009, 4);
  const { execFileSync } = await import("node:child_process");
  await writeFile(
    join(root, "guest.s"),
    `.syntax unified\n.cpu cortex-m7\n.thumb\n.section .text\n.word 0x20010000\n.word 0x08000009\nldr r0, =0x58020c00\nldr r1, [r0]\nldr r2, =0xff3fffff\nands r1, r2\nstr r1, [r0]\nldr r0, =0x58020c10\nldr r2, =0x20000100\nmovs r1, #1\nstr r1, [r2, #8]\nloop:\nldr r3, [r2, #12]\nadds r3, #1\nstr r3, [r2, #12]\nldr r1, [r0]\nlsrs r1, #11\nmovs r3, #1\nands r1, r3\nldr r3, [r2, #8]\ncmp r1, r3\nbeq loop\nstr r1, [r2, #8]\ncmp r1, #0\nbeq down\nldr r3, [r2, #4]\nadds r3, #1\nstr r3, [r2, #4]\nb loop\ndown:\nldr r3, [r2]\nadds r3, #1\nstr r3, [r2]\nb loop\n.ltorg\n`,
  );
  execFileSync("/opt/homebrew/bin/arm-none-eabi-as", [
    "-o",
    join(root, "guest.o"),
    join(root, "guest.s"),
  ]);
  execFileSync("/opt/homebrew/bin/arm-none-eabi-objcopy", [
    "-O",
    "binary",
    "-j",
    ".text",
    join(root, "guest.o"),
    join(root, "guest.bin"),
  ]);
  (await readFile(join(root, "guest.bin"))).copy(internal);
  await writeFile(join(root, "internal.bin"), internal);
  await writeFile(join(root, "external.bin"), external);
  const profile = await createProfile(join(root, "test.gnw.json"), {
    model: "mario",
    internalFlash: join(root, "internal.bin"),
    externalFlash: join(root, "external.bin"),
  });
  const original = kernel.kernelArguments;
  const qtest = join(root, "q.sock");
  const spy = vi
    .spyOn(kernel, "kernelArguments")
    .mockImplementation(async (...args) => [
      ...(await original(...args)),
      "-qtest",
      `unix:${qtest},server=on,wait=off`,
      "-qtest-log",
      "/dev/null",
    ]);
  const controller = new SessionController({
    kernel: "gwemu",
    qemu: binary,
    userData: join(root, "data"),
    managerDirectory: directory,
    timeout: 3000,
    logger: createLogManager({
      appInstanceId: "ms-native",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: () => createDisplayReceiver(() => {}),
  });
  const children = new Set<number>();
  controller.on("state", () => {
    const pid = controller.diagnostics().qemuPid;
    if (pid) children.add(pid);
  });
  const service = await startManagerSessionServer({
    ...options,
    controller,
    directory,
  });
  const peers: Awaited<ReturnType<typeof client>>[] = [];
  return {
    root,
    controller,
    service,
    profile,
    async connect() {
      const p = await client(service.descriptor.endpoint);
      peers.push(p);
      return p;
    },
    async hardware(command: string) {
      const socket = createConnection({ path: qtest });
      const reader = createInterface({ input: socket });
      const lines = reader[Symbol.asyncIterator]();
      try {
        await deadline(
          new Promise<void>((r, j) => {
            socket.once("connect", r);
            socket.once("error", j);
          }),
          1000,
          "qtest-connect",
        );
        socket.write(command + "\n");
        const line = (await deadline(lines.next(), 1000, "qtest-reply")).value!;
        expect(line).toMatch(/^OK/);
        return Number(line.slice(2).trim());
      } finally {
        reader.close();
        socket.destroy();
      }
    },
    async cleanup() {
      for (const p of peers) p.close();
      let serviceError: unknown;
      try {
        await deadline(service.close(), 5000, "service-close");
      } catch (error) {
        serviceError = error;
      }
      try {
        await deadline(
          controller.stop().catch(() => {}),
          7000,
          "controller-stop",
        );
      } finally {
        spy.mockRestore();
      }
      // Always reap the native, even if service cleanup itself failed.
      for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
      expect(await readFile(join(root, "internal.bin"))).toEqual(internal);
      expect(await readFile(join(root, "external.bin"))).toEqual(external);
      expect(await readdir(directory)).toEqual([]);
      await rm(root, { recursive: true, force: true });
      if (serviceError) throw serviceError;
    },
  };
}
async function rsp(path: string) {
  const socket = createConnection({ path });
  await deadline(
    new Promise<void>((r, j) => {
      socket.once("connect", r);
      socket.once("error", j);
    }),
    1000,
    "gdb-connect",
  );
  let buffer = Buffer.alloc(0);
  let waiting:
    | { resolve: (value: string) => void; reject: (error: Error) => void }
    | undefined;
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const start = buffer.indexOf(36),
        end = buffer.indexOf(35, start);
      if (start < 0 || end < 0 || buffer.length < end + 3) return;
      const payload = buffer.subarray(start + 1, end);
      const sum = [...payload].reduce((a, b) => a + b, 0) & 255;
      expect(parseInt(buffer.subarray(end + 1, end + 3).toString(), 16)).toBe(
        sum,
      );
      buffer = buffer.subarray(end + 3);
      socket.write("+");
      if (waiting) {
        const { resolve } = waiting;
        waiting = undefined;
        resolve(payload.toString());
      }
    }
  });
  socket.on("error", (error) => waiting?.reject(error));
  socket.on("close", () => waiting?.reject(new Error("GDB disconnected")));
  return {
    socket,
    async command(payload: string) {
      const value = new Promise<string>(
        (resolve, reject) => (waiting = { resolve, reject }),
      );
      const sum = [...Buffer.from(payload)].reduce((a, b) => a + b, 0) & 255;
      socket.write(`$${payload}#${sum.toString(16).padStart(2, "0")}`);
      return deadline(value, 1000, `gdb-response-${payload.slice(0, 24)}`);
    },
    async close() {
      if (socket.destroyed) return;
      const value = new Promise<void>((r) => socket.once("close", () => r()));
      socket.destroy();
      await deadline(value, 1000, "gdb-close");
    },
  };
}
const completion = {
  success: true,
  managerUploaded: false,
  memoryWritten: false,
  executionChanged: false,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Delay real transport bytes, never synthesize an RSP response. A queued
// continue can cross an early QMP stop, before the old native channel retires.
async function releaseRelay(
  path: string,
  native: string,
  queuedContinue: boolean,
  events: string[],
) {
  const queued = deferred(),
    closedPeer = deferred(),
    flush = deferred(),
    retired = deferred(),
    barrier = deferred(),
    proceed = deferred();
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((peer) => {
    const index = ++connections;
    peer.on("error", () => {});
    peer.pause();
    sockets.add(peer);
    void (async () => {
      if (index > 1) await retired.promise;
      if (peer.destroyed) return;
      const upstream = createConnection({ path: native });
      sockets.add(upstream);
      upstream.on("error", () => peer.destroy());
      let pending: Buffer | undefined;
      const acknowledged = deferred();
      let continuing = false;
      peer.on("data", (data) => {
        const start =
          queuedContinue && index === 1 ? data.indexOf(packet("c")) : -1;
        if (start < 0) upstream.write(data);
        else {
          if (start) upstream.write(data.subarray(0, start));
          pending = data.subarray(start);
          queued.resolve();
        }
      });
      upstream.on("data", (data) => {
        if (continuing && data.includes(43)) acknowledged.resolve();
        if (index > 1) {
          barrier.resolve();
          void proceed.promise.then(() => {
            events.push("barrier-forwarded");
            if (!peer.destroyed) peer.write(data);
          });
        } else if (!peer.destroyed) peer.write(data);
      });
      upstream.on("close", () => {
        peer.destroy();
        if (index === 1) retired.resolve();
      });
      peer.on("close", () => {
        closedPeer.resolve();
        void (async () => {
          if (pending) {
            await flush.promise;
            continuing = true;
            upstream.write(pending);
            await deadline(acknowledged.promise, 1000, "queued-continue-ack");
            events.push("queued-continue-acked");
          }
          upstream.destroy();
        })().catch(() => upstream.destroy());
      });
      upstream.once("connect", () => peer.resume());
    })().catch(() => peer.destroy());
  });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    }),
    1000,
    "release-relay-listen",
  );
  await chmod(path, 0o600);
  return {
    queued,
    closedPeer,
    flush,
    barrier,
    proceed,
    async close() {
      flush.resolve();
      proceed.resolve();
      retired.resolve();
      for (const socket of sockets) socket.destroy();
      await deadline(
        new Promise<void>((resolve) => server.close(() => resolve())),
        1000,
        "release-relay-close",
      );
    },
  };
}

test.each([false, true])(
  "failed release retains UI ownership until real native retirement (queued continue: %s)",
  async (queuedContinue) => {
    const f = await nativeFixture();
    const events: string[] = [];
    let relay: Awaited<ReturnType<typeof releaseRelay>> | undefined;
    let g: Awaited<ReturnType<typeof rsp>> | undefined;
    let admission: ReturnType<typeof vi.spyOn> | undefined;
    const { QmpClient } = await import("../../src/core/qmp-client");
    const originalCommand = QmpClient.prototype.command;
    let qmp: InstanceType<typeof QmpClient> | undefined;
    const commands = vi
      .spyOn(QmpClient.prototype, "command")
      .mockImplementation(function (
        this: InstanceType<typeof QmpClient>,
        ...args
      ) {
        qmp = this;
        events.push(args[0]);
        return originalCommand.apply(this, args);
      });
    try {
      await f.controller.load(f.profile.path);
      const original = f.controller.beginManager.bind(f.controller);
      admission = vi
        .spyOn(f.controller, "beginManager")
        .mockImplementation(async (...args) => {
          const acquired = await original(...args);
          const path = join(f.root, "retirement.sock");
          relay = await releaseRelay(
            path,
            acquired.gdbEndpoint,
            queuedContinue,
            events,
          );
          return { ...acquired, gdbEndpoint: path };
        });
      const a = await acquire(f);
      g = await rsp(a.gdbEndpoint);
      expect(await g.command("m08000000,8")).toBe("0000012009000008");
      if (queuedContinue) {
        g.socket.write(packet("c"));
        await deadline(relay!.queued.promise, 1000, "continue-queued");
      }
      const released = a.p.call("release", {
        sessionId: a.sessionId,
        leaseId: a.leaseId,
        completion: { ...completion, success: false },
      });
      released.catch(() => {});
      await deadline(relay!.closedPeer.promise, 1000, "proxy-retired");
      relay!.flush.resolve();
      await deadline(relay!.barrier.promise, 1000, "real-barrier-reply-held");
      // Give any premature controller retirement a deterministic opportunity to
      // finish while the real native barrier's reply remains withheld.
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(f.controller.state.deviceOperation).toBe(true);
      await expect(f.controller.load(f.profile.path)).rejects.toMatchObject({
        code: "error.busy",
      });
      await expect(f.controller.setMuted(true)).rejects.toMatchObject({
        code: "error.busy",
      });
      f.controller.key("ArrowLeft", true);
      await f.controller.instantState("save");
      expect(f.controller.inputState().desiredMask).toBe(0);
      expect(f.controller.state.stateOperation).toBeUndefined();
      if (queuedContinue)
        expect(await qmp!.command("query-status")).toMatchObject({
          running: true,
        });
      relay!.proceed.resolve();
      expect(await released).toMatchObject({
        ok: true,
        result: { session: { sessionId: a.sessionId, execution: "unknown" } },
      });
      expect(events.lastIndexOf("stop")).toBeGreaterThan(
        events.lastIndexOf("barrier-forwarded"),
      );
      expect(await qmp!.command("query-status")).toMatchObject({
        running: false,
      });
      const counter = await f.hardware("readl 0x2000010c");
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(await f.hardware("readl 0x2000010c")).toBe(counter);
      await expect(lstat(a.gdbEndpoint)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      relay?.flush.resolve();
      relay?.proceed.resolve();
      await g?.close();
      admission?.mockRestore();
      commands.mockRestore();
      try {
        await f.cleanup();
      } finally {
        await relay?.close();
      }
    }
  },
);

test.each(["stop", "expiry", "disconnect"] as const)(
  "%s during the real native release barrier cannot drop ownership or restore execution",
  async (kind) => {
    const clock = manualClock();
    const f = await nativeFixture({ clock });
    const events: string[] = [];
    let relay: Awaited<ReturnType<typeof releaseRelay>> | undefined;
    let g: Awaited<ReturnType<typeof rsp>> | undefined;
    let admission: ReturnType<typeof vi.spyOn> | undefined;
    const { QmpClient } = await import("../../src/core/qmp-client");
    const originalCommand = QmpClient.prototype.command;
    let qmp: InstanceType<typeof QmpClient> | undefined;
    const commands = vi
      .spyOn(QmpClient.prototype, "command")
      .mockImplementation(function (
        this: InstanceType<typeof QmpClient>,
        ...args
      ) {
        qmp = this;
        events.push(args[0]);
        return originalCommand.apply(this, args);
      });
    try {
      await f.controller.load(f.profile.path);
      const original = f.controller.beginManager.bind(f.controller);
      admission = vi
        .spyOn(f.controller, "beginManager")
        .mockImplementation(async (...args) => {
          const acquired = await original(...args);
          const path = join(f.root, "retirement.sock");
          relay = await releaseRelay(path, acquired.gdbEndpoint, false, events);
          return { ...acquired, gdbEndpoint: path };
        });
      const a = await acquire(f, "manage", 20000);
      g = await rsp(a.gdbEndpoint);
      expect(await g.command("m08000000,8")).toBe("0000012009000008");
      const releasing = a.p
        .call("release", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
          completion: { ...completion, success: kind === "expiry" },
        })
        .catch(() => undefined);
      await deadline(
        relay!.barrier.promise,
        1000,
        "real-release-barrier-entered",
      );
      const boundary = events.length;
      if (kind === "stop") {
        // The transport gate remains blocked: UI stop must revoke and reap
        // the real native without waiting for a test-controlled reply.
        await expect(
          deadline(f.controller.stop(), 3000, "stop-during-release"),
        ).rejects.toMatchObject({ code: "error.saveUncertain" });
        expect(a.p.socket.destroyed).toBe(true);
        await releasing;
        relay!.proceed.resolve();
        await relay!.close();
        relay = undefined;
        admission.mockRestore();
        admission = undefined;
        await vi.waitFor(
          async () =>
            expect(
              (await readdir(join(f.root, "private"))).filter((name) =>
                name.startsWith("l-"),
              ),
            ).toEqual([]),
          { timeout: 1000 },
        );
        await f.controller.load(f.profile.path);
        const newer = await acquire(f);
        expect(newer.sessionId).not.toBe(a.sessionId);
        expect(
          await newer.p.call("release", {
            sessionId: newer.sessionId,
            leaseId: newer.leaseId,
            completion,
          }),
        ).toMatchObject({
          ok: true,
          result: {
            session: { sessionId: newer.sessionId, execution: "running" },
          },
        });
      } else {
        if (kind === "expiry") clock.advance(20000);
        else a.p.close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.controller.state.deviceOperation).toBe(true);
        await expect(f.controller.load(f.profile.path)).rejects.toMatchObject({
          code: "error.busy",
        });
        relay!.proceed.resolve();
        const result = await releasing;
        if (kind === "expiry")
          expect(result).toMatchObject({
            ok: false,
            error: { code: "LEASE_EXPIRED" },
          });
        await vi.waitFor(
          () => expect(f.controller.state.execution).toBe("unknown"),
          { timeout: 1000 },
        );
        expect(events.slice(boundary)).not.toContain("cont");
        expect(await qmp!.command("query-status")).toMatchObject({
          running: false,
        });
        await vi.waitFor(
          async () =>
            expect(
              (await readdir(join(f.root, "private"))).filter((name) =>
                name.startsWith("l-"),
              ),
            ).toEqual([]),
          { timeout: 1000 },
        );
      }
    } finally {
      relay?.proceed.resolve();
      await g?.close();
      admission?.mockRestore();
      commands.mockRestore();
      try {
        await f.cleanup();
      } finally {
        await relay?.close();
      }
    }
  },
);

test("actual native lease is bound to RPC connection and one GDB proxy, release invalidates it", async () => {
  const f = await nativeFixture();
  let gdb: Awaited<ReturnType<typeof rsp>> | undefined;
  try {
    await f.controller.load(f.profile.path);
    const p = await f.connect(),
      other = await f.connect();
    const listed = await p.call("list");
    expect(listed.result.sessions).toHaveLength(1);
    const sessionId = listed.result.sessions[0].sessionId;
    const acquired = await p.call("acquire", {
      sessionId,
      operation: "manage",
      timeoutMs: 10000,
    });
    expect(acquired).toMatchObject({
      ok: true,
      result: { sessionId, initial: { execution: "running" } },
    });
    const { leaseId, gdbEndpoint } = acquired.result;
    expect(gdbEndpoint).toMatch(/\/l-[a-f0-9]{16}\.sock$/);
    expect((await lstat(gdbEndpoint)).mode & 0o777).toBe(0o600);
    await expect(f.controller.load(f.profile.path)).rejects.toThrow();
    expect(await other.call("status", { sessionId, leaseId })).toMatchObject({
      ok: false,
      error: { code: "NOT_OWNER" },
    });
    gdb = await rsp(gdbEndpoint);
    expect(await gdb.command("m08000000,8")).toBe("0000012009000008");
    expect(await gdb.command("g")).toMatch(/^[a-f0-9]{128,}$/);
    const second = createConnection({ path: gdbEndpoint });
    second.on("error", () => {});
    await deadline(
      new Promise<void>((r) => second.once("close", () => r())),
      1000,
      "second-client-refusal",
    );
    await gdb.close();
    gdb = await rsp(gdbEndpoint);
    expect(await gdb.command("m08000000,8")).toBe("0000012009000008");
    const released = await p.call("release", {
      sessionId,
      leaseId,
      completion,
    });
    expect(released).toMatchObject({
      ok: true,
      result: { session: { execution: "running" } },
    });
    expect(gdb.socket.destroyed).toBe(true);
    await expect(lstat(gdbEndpoint)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await p.call("status", { sessionId, leaseId })).toMatchObject({
      ok: false,
      error: { code: "LEASE_EXPIRED" },
    });
  } finally {
    await gdb?.close();
    await f.cleanup();
  }
});

test("owner disconnect during successful release cannot restore application execution", async () => {
  const f = await nativeFixture();
  try {
    await f.controller.load(f.profile.path);
    const p = await f.connect();
    const sessionId = (await p.call("list")).result.sessions[0].sessionId;
    const { leaseId } = (
      await p.call("acquire", {
        sessionId,
        operation: "manage",
        timeoutMs: 10000,
      })
    ).result;
    let entered!: () => void, proceed!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (proceed = r));
    const original = f.controller.endManager.bind(f.controller);
    const spy = vi
      .spyOn(f.controller, "endManager")
      .mockImplementation(async (owner, result) => {
        if (result.success) {
          entered();
          await gate;
        }
        return original(owner, result);
      });
    const released = p
      .call("release", { sessionId, leaseId, completion })
      .catch(() => undefined);
    await deadline(started, 2000, "release-entered");
    p.close();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    proceed();
    await released;
    await vi.waitFor(
      () => expect(f.controller.state.execution).toBe("unknown"),
      { timeout: 2000 },
    );
    spy.mockRestore();
  } finally {
    await f.cleanup();
  }
});

function manualClock() {
  let now = 0,
    sequence = 0;
  const scheduled = new Map<number, { when: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number) {
      const id = ++sequence;
      scheduled.set(id, { when: now + ms, callback });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout(id: NodeJS.Timeout) {
      scheduled.delete(id as unknown as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, item] of [...scheduled])
        if (item.when <= now) {
          scheduled.delete(id);
          item.callback();
        }
    },
  };
}
async function acquire(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  operation = "manage",
  timeoutMs = 10000,
) {
  const p = await f.connect();
  const sessionId = (await p.call("list")).result.sessions[0].sessionId;
  const response = await p.call("acquire", { sessionId, operation, timeoutMs });
  expect(response.ok).toBe(true);
  return { p, sessionId, ...response.result };
}

test("real Unix framing enforces UTF-8, version, size, outstanding and connection bounds", async () => {
  const root = await mkdtemp("/tmp/gnw-ms-bounds-");
  const peers: Awaited<ReturnType<typeof client>>[] = [];
  const s = await startManagerSessionServer({
    controller: emptyController(root),
    directory: join(root, "p"),
  });
  try {
    const p = await client(s.descriptor.endpoint);
    peers.push(p);
    // Split a multibyte request ID inside its UTF-8 encoding; all fragments cross a real socket.
    const frame = Buffer.from(
      JSON.stringify({ protocol: 1, id: "中文", method: "list", params: {} }) +
        "\n",
    );
    const received = new Promise<any>((r) =>
      p.socket.once("data", (b) => r(JSON.parse(b.toString()))),
    );
    const at = frame.indexOf(Buffer.from("中")) + 1;
    p.socket.write(frame.subarray(0, at));
    await new Promise<void>((r) => setImmediate(r));
    p.socket.write(frame.subarray(at));
    expect(await deadline(received, 1000, "fragmented-utf8")).toMatchObject({
      id: "中文",
      ok: true,
    });
    expect(
      await p.send({ protocol: 2, method: "list", params: {} }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
    const ninth = new Promise<any>((resolve) => {
      let result = "";
      const data = (b: Buffer) => {
        result += b.toString();
        const lines = result.trim().split("\n");
        if (lines.length === 9) {
          p.socket.off("data", data);
          resolve(lines.map((x) => JSON.parse(x)));
        }
      };
      p.socket.on("data", data);
    });
    p.socket.write(
      Array.from(
        { length: 9 },
        (_, i) =>
          JSON.stringify({
            protocol: 1,
            id: `batch-${i}`,
            method: "list",
            params: {},
          }) + "\n",
      ).join(""),
    );
    const replies = await deadline(ninth, 1000, "outstanding-limit");
    expect(replies.filter((r: any) => r.ok)).toHaveLength(8);
    expect(replies.find((r: any) => !r.ok)).toMatchObject({
      error: { code: "BUSY" },
    });
    for (let i = 1; i < 16; i++) {
      const peer = await client(s.descriptor.endpoint);
      peers.push(peer);
      expect((await peer.call("list")).ok).toBe(true);
    }
    const excess = createConnection({ path: s.descriptor.endpoint });
    excess.on("error", () => {});
    await deadline(
      new Promise<void>((r) => excess.once("close", r)),
      1000,
      "connection-limit",
    );
    const ended = new Promise<void>((r) => p.socket.once("close", r));
    p.socket.write(Buffer.alloc(65536, 32));
    await deadline(ended, 1000, "oversize-close");
  } finally {
    for (const p of peers) p.close();
    await s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["idle", "absolute"])(
  "injected monotonic clock expires %s despite heartbeat/status",
  async (kind) => {
    const clock = manualClock(),
      f = await nativeFixture({ clock });
    try {
      await f.controller.load(f.profile.path);
      const a = await acquire(f, "manage", kind === "idle" ? 120000 : 40000);
      clock.advance(20000);
      expect(
        await a.p.call("heartbeat", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
        }),
      ).toMatchObject({ ok: true, result: { expiresAt: a.expiresAt } });
      clock.advance(kind === "idle" ? 29999 : 19999);
      expect(
        (
          await a.p.call("status", {
            sessionId: a.sessionId,
            leaseId: a.leaseId,
          })
        ).ok,
      ).toBe(true);
      clock.advance(1);
      await vi.waitFor(
        () => expect(f.controller.state.execution).toBe("unknown"),
        { timeout: 2000 },
      );
      expect(
        await a.p.call("status", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
        }),
      ).toMatchObject({ ok: false, error: { code: "LEASE_EXPIRED" } });
      expect(
        await a.p.call("acquire", {
          sessionId: a.sessionId,
          operation: "read",
          timeoutMs: 10000,
        }),
      ).toMatchObject({ ok: false, error: { code: "UNCERTAIN" } });
    } finally {
      await f.cleanup();
    }
  },
);

test("long real press uses dynamic RPC budget, heartbeat stays fast and mark rejects BUSY", async () => {
  const f = await nativeFixture({ rpcTimeoutMs: 300 });
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f);
    const down = await f.hardware("readl 0x20000100"),
      up = await f.hardware("readl 0x20000104");
    const started = performance.now();
    const press = a.p.call("control", {
      sessionId: a.sessionId,
      leaseId: a.leaseId,
      action: "press",
      value: { mask: 1, durationMs: 650 },
    });
    press.catch(() => {});
    await vi.waitFor(
      async () =>
        expect((await f.hardware("readl 0x58020c10")) & (1 << 11)).toBe(0),
      { timeout: 250 },
    );
    const at = performance.now();
    expect(
      (
        await a.p.call("heartbeat", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
        })
      ).ok,
    ).toBe(true);
    expect(performance.now() - at).toBeLessThan(200);
    expect(
      await a.p.call("mark", {
        sessionId: a.sessionId,
        leaseId: a.leaseId,
        managerUploaded: false,
        memoryWritten: true,
        executionChanged: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "BUSY" } });
    expect(await press).toMatchObject({
      ok: true,
      result: { session: { execution: "paused" } },
    });
    expect(performance.now() - started).toBeGreaterThan(650);
    expect(await f.hardware("readl 0x20000100")).toBeGreaterThan(down);
    expect(await f.hardware("readl 0x20000104")).toBeGreaterThan(up);
    expect(await f.hardware("readl 0x58020c10")).toBe(0xffff);
    expect(
      await a.p.call("release", {
        sessionId: a.sessionId,
        leaseId: a.leaseId,
        completion,
      }),
    ).toMatchObject({
      ok: true,
      result: { session: { execution: "running" } },
    });
  } finally {
    await f.cleanup();
  }
});

test("absolute expiry cancels held native input without any later application cont", async () => {
  const clock = manualClock(),
    f = await nativeFixture({ clock });
  const { QmpClient } = await import("../../src/core/qmp-client");
  const original = QmpClient.prototype.command;
  const commands: string[] = [];
  const spy = vi
    .spyOn(QmpClient.prototype, "command")
    .mockImplementation(function (
      this: InstanceType<typeof QmpClient>,
      ...args
    ) {
      commands.push(args[0]);
      return original.apply(this, args);
    });
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f, "manage", 10000);
    const press = a.p.call("control", {
      sessionId: a.sessionId,
      leaseId: a.leaseId,
      action: "press",
      value: { mask: 1, durationMs: 1000 },
    });
    press.catch(() => {});
    await vi.waitFor(
      async () =>
        expect((await f.hardware("readl 0x58020c10")) & (1 << 11)).toBe(0),
      { timeout: 300 },
    );
    const boundary = commands.length;
    clock.advance(10000);
    expect(await press).toMatchObject({
      ok: false,
      error: { code: "LEASE_EXPIRED" },
    });
    await vi.waitFor(
      () => expect(f.controller.state.execution).toBe("unknown"),
      { timeout: 2000 },
    );
    expect(await f.hardware("readl 0x58020c10")).toBe(0xffff);
    expect(commands.slice(boundary)).not.toContain("cont");
  } finally {
    spy.mockRestore();
    await f.cleanup();
  }
});

function packet(payload: string) {
  const sum = [...Buffer.from(payload)].reduce((a, b) => a + b, 0) & 255;
  return `$${payload}#${sum.toString(16).padStart(2, "0")}`;
}

test("partial old native write is synchronized before proxy reconnect and success release", async () => {
  const f = await nativeFixture();
  let g: Awaited<ReturnType<typeof rsp>> | undefined;
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f);
    expect(
      (
        await a.p.call("mark", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
          managerUploaded: false,
          memoryWritten: true,
          executionChanged: false,
        })
      ).ok,
    ).toBe(true);
    g = await rsp(a.gdbEndpoint);
    expect(await g.command("M20000200,4:11223344")).toBe("OK");
    g.socket.write("$M20000204,4:aa");
    await new Promise<void>((r) => setTimeout(r, 20));
    await g.close();
    // The fresh native qSupported response is required before forwarding this new client.
    await new Promise<void>((r) => setTimeout(r, 20));
    g = await rsp(a.gdbEndpoint);
    expect(await g.command("m20000200,8")).toBe("1122334400000000");
    g.socket.write("$M20000204,4:bb");
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(
      await a.p.call("release", {
        sessionId: a.sessionId,
        leaseId: a.leaseId,
        completion,
      }),
    ).toMatchObject({
      ok: true,
      result: { session: { execution: "running" } },
    });
    expect(await f.hardware("readl 0x20000204")).toBe(0);
    const before = await f.hardware("readl 0x2000010c");
    await vi.waitFor(
      async () =>
        expect(await f.hardware("readl 0x2000010c")).toBeGreaterThan(before),
      { timeout: 500 },
    );
  } finally {
    await g?.close();
    await f.cleanup();
  }
});

test("queued native memory/register writes cannot reach the application after release", async () => {
  const f = await nativeFixture();
  let g: Awaited<ReturnType<typeof rsp>> | undefined;
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f);
    expect(
      (
        await a.p.call("mark", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
          managerUploaded: false,
          memoryWritten: true,
          executionChanged: true,
        })
      ).ok,
    ).toBe(true);
    g = await rsp(a.gdbEndpoint);
    expect(await g.command("M20000200,4:efbeadde")).toBe("OK");
    // Over 1 MiB is queued at the real stream boundary while the first packets are acknowledged.
    // Poison PC and memory repeatedly: any post-reset packet would halt the running guest or corrupt the sentinel.
    const writes = (
      packet("M20000200,4:efbeadde") + packet("Pf=01020020")
    ).repeat(32768);
    g.socket.write(writes);
    g.socket.write("$M20000204,4:aa");
    expect(
      await a.p.call("release", {
        sessionId: a.sessionId,
        leaseId: a.leaseId,
        completion,
      }),
    ).toMatchObject({
      ok: true,
      result: { session: { execution: "running" } },
    });
    expect(g.socket.destroyed).toBe(true);
    await f.hardware("writel 0x20000200 0x76543210");
    const before = await f.hardware("readl 0x2000010c");
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      expect(await f.hardware("readl 0x20000200")).toBe(0x76543210);
      expect(await f.hardware("readl 0x2000010c")).toBeGreaterThan(before);
    }
    const newer = await acquire(f, "read");
    expect(newer.leaseId).not.toBe(a.leaseId);
    g = await rsp(newer.gdbEndpoint);
    const registers = await g.command("g");
    const restoredPc = Buffer.from(
      registers.slice(120, 128),
      "hex",
    ).readUInt32LE();
    expect(restoredPc).toBeGreaterThanOrEqual(0x08000008);
    expect(restoredPc).toBeLessThan(0x08000080);
    expect(
      (
        await newer.p.call("release", {
          sessionId: newer.sessionId,
          leaseId: newer.leaseId,
          completion,
        })
      ).ok,
    ).toBe(true);
  } finally {
    await g?.close();
    await f.cleanup();
  }
});

test("read/debug leases enforce device and target gates, marked GDB mutation resets before restore", async () => {
  const f = await nativeFixture();
  let g: Awaited<ReturnType<typeof rsp>> | undefined;
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f, "read");
    expect(
      await a.p.call("control", {
        sessionId: a.sessionId,
        leaseId: a.leaseId,
        action: "pause",
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_OWNER" } });
    expect(
      (
        await a.p.call("release", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
          completion,
        })
      ).ok,
    ).toBe(true);
    const d = await acquire(f, "debug");
    expect(
      await d.p.call("control", {
        sessionId: d.sessionId,
        leaseId: d.leaseId,
        action: "press",
        value: { mask: 1, durationMs: 10 },
      }),
    ).toMatchObject({ ok: false, error: { code: "TARGET_UNSAFE" } });
    expect(
      await d.p.call("control", {
        sessionId: d.sessionId,
        leaseId: d.leaseId,
        action: "resume",
      }),
    ).toMatchObject({ ok: false, error: { code: "TARGET_UNSAFE" } });
    expect(
      (
        await d.p.call("control", {
          sessionId: d.sessionId,
          leaseId: d.leaseId,
          action: "warm-reset",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await d.p.call("mark", {
          sessionId: d.sessionId,
          leaseId: d.leaseId,
          managerUploaded: false,
          memoryWritten: true,
          executionChanged: true,
        })
      ).ok,
    ).toBe(true);
    g = await rsp(d.gdbEndpoint);
    expect(await g.command("Pf=01020020")).toBe("OK");
    expect(
      await d.p.call("release", {
        sessionId: d.sessionId,
        leaseId: d.leaseId,
        completion,
      }),
    ).toMatchObject({ ok: true, result: { session: { execution: "paused" } } });
    const m = await acquire(f);
    g = await rsp(m.gdbEndpoint);
    const registers = await g.command("g");
    expect(Buffer.from(registers.slice(120, 128), "hex").readUInt32LE()).toBe(
      0x08000008,
    );
    for (const [action, value] of [
      ["battery-present", false],
      ["usb-power", false],
    ] as const)
      expect(
        (
          await m.p.call("control", {
            sessionId: m.sessionId,
            leaseId: m.leaseId,
            action,
            value,
          })
        ).ok,
      ).toBe(true);
    expect(
      await m.p.call("control", {
        sessionId: m.sessionId,
        leaseId: m.leaseId,
        action: "resume",
      }),
    ).toMatchObject({ ok: false, error: { code: "NO_POWER" } });
    expect(
      await m.p.call("release", {
        sessionId: m.sessionId,
        leaseId: m.leaseId,
        completion,
      }),
    ).toMatchObject({
      ok: true,
      result: { session: { execution: "unpowered" } },
    });
  } finally {
    await g?.close();
    await f.cleanup();
  }
});

test("controller stop revokes RPC/GDB immediately and a new ROM has new endpoints and owner", async () => {
  const f = await nativeFixture();
  let g: Awaited<ReturnType<typeof rsp>> | undefined;
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f);
    g = await rsp(a.gdbEndpoint);
    expect(await g.command("m08000000,8")).toBe("0000012009000008");
    const oldNative = f.controller.diagnostics().qemuPid;
    await expect(f.controller.stop()).rejects.toMatchObject({
      code: "error.saveUncertain",
    });
    await vi.waitFor(
      () => {
        expect(g!.socket.destroyed).toBe(true);
        expect(a.p.socket.destroyed).toBe(true);
      },
      { timeout: 1000 },
    );
    await f.controller.load(f.profile.path);
    expect(f.controller.diagnostics().qemuPid).not.toBe(oldNative);
    const b = await acquire(f);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.gdbEndpoint).not.toBe(a.gdbEndpoint);
    expect(
      await b.p.call("status", { sessionId: a.sessionId, leaseId: a.leaseId }),
    ).toMatchObject({ ok: false, error: { code: "STALE_SESSION" } });
    expect(
      await b.p.call("status", { sessionId: b.sessionId, leaseId: b.leaseId }),
    ).toMatchObject({
      ok: true,
      result: { session: { sessionId: b.sessionId } },
    });
    expect(
      (
        await b.p.call("release", {
          sessionId: b.sessionId,
          leaseId: b.leaseId,
          completion,
        })
      ).ok,
    ).toBe(true);
  } finally {
    await g?.close();
    await f.cleanup();
  }
});

test.each(["stop", "native-exit"])(
  "%s during actual admission revokes owner and permits a fresh session",
  async (kind) => {
    const f = await nativeFixture();
    let proceed!: () => void;
    try {
      await f.controller.load(f.profile.path);
      const p = await f.connect();
      const sessionId = (await p.call("list")).result.sessions[0].sessionId;
      let entered!: () => void;
      const ready = new Promise<void>((r) => (entered = r)),
        gate = new Promise<void>((r) => (proceed = r));
      const original = f.controller.beginManager.bind(f.controller);
      const spy = vi
        .spyOn(f.controller, "beginManager")
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          entered();
          await gate;
          return result;
        });
      const acquiring = p
        .call("acquire", { sessionId, operation: "manage", timeoutMs: 10000 })
        .catch(() => undefined);
      await deadline(ready, 1000, "admission-ready");
      if (kind === "stop")
        await expect(f.controller.stop()).rejects.toMatchObject({
          code: "error.saveUncertain",
        });
      else {
        const pid = f.controller.diagnostics().qemuPid!;
        process.kill(pid, "SIGTERM");
        await vi.waitFor(() => expect(p.socket.destroyed).toBe(true), {
          timeout: 2000,
        });
        await f.controller.stop().catch(() => {});
      }
      expect(p.socket.destroyed).toBe(true);
      proceed();
      await acquiring;
      spy.mockRestore();
      await vi.waitFor(
        async () =>
          expect(
            (await readdir(join(f.root, "private"))).filter((n) =>
              n.startsWith("l-"),
            ),
          ).toEqual([]),
        { timeout: 2000 },
      );
      await f.controller.load(f.profile.path);
      const b = await acquire(f);
      expect(b.sessionId).not.toBe(sessionId);
      expect(
        (
          await b.p.call("release", {
            sessionId: b.sessionId,
            leaseId: b.leaseId,
            completion,
          })
        ).ok,
      ).toBe(true);
    } finally {
      proceed?.();
      await f.cleanup();
    }
  },
);

test("failed actual proxy publication returns sanitized failure and leaves no lease socket", async () => {
  const f = await nativeFixture();
  const { ManagerEndpointDirectory } =
    await import("../../src/core/manager-endpoints");
  const original = ManagerEndpointDirectory.prototype.socket;
  const spy = vi
    .spyOn(ManagerEndpointDirectory.prototype, "socket")
    .mockImplementation(function (
      this: InstanceType<typeof ManagerEndpointDirectory>,
      ...args
    ) {
      if (args[0] === "lease")
        return Promise.reject(
          new Error("/private/secret/image.bin internal stack"),
        );
      return original.apply(this, args);
    });
  try {
    await f.controller.load(f.profile.path);
    const p = await f.connect();
    const sessionId = (await p.call("list")).result.sessions[0].sessionId;
    const response = await p.call("acquire", {
      sessionId,
      operation: "manage",
      timeoutMs: 10000,
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "INTERNAL", message: "Management operation failed" },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(
      (await readdir(join(f.root, "private"))).filter((n) =>
        n.startsWith("l-"),
      ),
    ).toEqual([]);
    expect(f.controller.state.execution).toBe("unknown");
    spy.mockRestore();
    await f.controller.stop().catch(() => {});
    await f.controller.load(f.profile.path);
    const b = await acquire(f);
    expect(
      (
        await b.p.call("release", {
          sessionId: b.sessionId,
          leaseId: b.leaseId,
          completion,
        })
      ).ok,
    ).toBe(true);
  } finally {
    spy.mockRestore();
    await f.cleanup();
  }
});

test("RPC press timeout cancels a still-held guest key without later cont or input", async () => {
  const f = await nativeFixture({ rpcTimeoutMs: 300 });
  let proceed!: () => void;
  const { QmpClient } = await import("../../src/core/qmp-client");
  const original = QmpClient.prototype.command;
  const commands: string[] = [];
  const spy = vi
    .spyOn(QmpClient.prototype, "command")
    .mockImplementation(function (
      this: InstanceType<typeof QmpClient>,
      ...args
    ) {
      commands.push(args[0]);
      return original.apply(this, args);
    });
  const { KernelBackend } = await import("../../src/core/kernel-backend");
  const buttons = KernelBackend.prototype.buttons;
  let delayed: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f);
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (proceed = r));
    // A real native key-down has completed, but its confirmation is delayed beyond the RPC budget.
    delayed = vi
      .spyOn(KernelBackend.prototype, "buttons")
      .mockImplementation(async function (
        this: InstanceType<typeof KernelBackend>,
        mask,
        timeout,
      ) {
        const result = await buttons.call(this, mask, timeout);
        if (mask === 1) {
          entered();
          await gate;
        }
        return result;
      });
    const press = a.p.call("control", {
      sessionId: a.sessionId,
      leaseId: a.leaseId,
      action: "press",
      value: { mask: 1, durationMs: 100 },
    });
    press.catch(() => {});
    await deadline(ready, 300, "keydown-confirmed");
    expect((await f.hardware("readl 0x58020c10")) & (1 << 11)).toBe(0);
    const boundary = commands.length;
    expect(await press).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    });
    await vi.waitFor(
      () => expect(f.controller.state.execution).toBe("unknown"),
      { timeout: 2000 },
    );
    expect(await f.hardware("readl 0x58020c10")).toBe(0xffff);
    const afterCleanup = commands.length;
    proceed();
    await new Promise<void>((r) => setTimeout(r, 150));
    expect(commands.slice(boundary)).not.toContain("cont");
    expect(commands.slice(afterCleanup)).not.toContain("input-send-event");
  } finally {
    proceed?.();
    delayed?.mockRestore();
    spy.mockRestore();
    await f.cleanup();
  }
});

test("service publication failure cleans bound sockets; close retains replacement descriptor", async () => {
  const root = await mkdtemp("/tmp/gnw-ms-publish-");
  const directory = join(root, "p");
  const { ManagerEndpointDirectory } =
    await import("../../src/core/manager-endpoints");
  try {
    const spy = vi
      .spyOn(ManagerEndpointDirectory.prototype, "publishDescriptor")
      .mockRejectedValueOnce(new Error("publication failed"));
    await expect(
      startManagerSessionServer({
        controller: emptyController(root),
        directory,
      }),
    ).rejects.toThrow("publication failed");
    spy.mockRestore();
    expect(await readdir(directory)).toEqual([]);
    const s = await startManagerSessionServer({
      controller: emptyController(root),
      directory,
    });
    await unlink(s.descriptorPath);
    await writeFile(s.descriptorPath, "replacement", { mode: 0o600 });
    await s.close();
    await s.close();
    expect(await readFile(s.descriptorPath, "utf8")).toBe("replacement");
    expect(await readdir(directory)).toEqual([s.descriptor.serverId + ".json"]);
    await expect(
      startManagerSessionServer({
        controller: emptyController(root),
        directory,
        platform: "win32",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await chmod(directory, 0o755);
    await expect(
      startManagerSessionServer({
        controller: emptyController(root),
        directory,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service close withdraws discovery and RPC immediately while native cleanup is delayed", async () => {
  const f = await nativeFixture();
  let proceed!: () => void;
  try {
    await f.controller.load(f.profile.path);
    const a = await acquire(f);
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (proceed = r));
    const original = f.controller.endManager.bind(f.controller);
    const spy = vi
      .spyOn(f.controller, "endManager")
      .mockImplementation(async (...args) => {
        entered();
        await gate;
        return original(...args);
      });
    const closing = f.service.close();
    closing.catch(() => {});
    await deadline(ready, 500, "close-cleanup-entered");
    try {
      await vi.waitFor(() => expect(a.p.socket.destroyed).toBe(true), {
        timeout: 300,
      });
      await expect(lstat(f.service.descriptorPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      proceed();
      await deadline(closing, 3000, "close-cleanup-finished");
      spy.mockRestore();
    }
  } finally {
    proceed?.();
    await f.cleanup();
  }
});

test.each(["idle", "absolute"])(
  "%s expiry during successful release revokes restore before delayed native completion",
  async (kind) => {
    const clock = manualClock(),
      f = await nativeFixture({ clock });
    let proceed!: () => void;
    const { QmpClient } = await import("../../src/core/qmp-client");
    const command = QmpClient.prototype.command;
    const commands: string[] = [];
    const qmpSpy = vi
      .spyOn(QmpClient.prototype, "command")
      .mockImplementation(function (
        this: InstanceType<typeof QmpClient>,
        ...args
      ) {
        commands.push(args[0]);
        return command.apply(this, args);
      });
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await f.controller.load(f.profile.path);
      const a = await acquire(f, "manage", kind === "idle" ? 60000 : 20000);
      clock.advance(kind === "idle" ? 29990 : 19990);
      let entered!: () => void;
      const ready = new Promise<void>((r) => (entered = r)),
        gate = new Promise<void>((r) => (proceed = r));
      const endManager = f.controller.endManager.bind(f.controller);
      spy = vi
        .spyOn(f.controller, "endManager")
        .mockImplementation(async (owner, result) => {
          if (result.success) {
            entered();
            await gate;
          }
          return endManager(owner, result);
        });
      const released = a.p
        .call("release", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
          completion,
        })
        .catch(() => undefined);
      await deadline(ready, 1000, "release-restore-entered");
      const boundary = commands.length;
      clock.advance(10);
      proceed();
      await released;
      await vi.waitFor(
        () => expect(f.controller.state.execution).toBe("unknown"),
        { timeout: 1000 },
      );
      expect(commands.slice(boundary)).not.toContain("cont");
    } finally {
      proceed?.();
      spy?.mockRestore();
      qmpSpy.mockRestore();
      await f.cleanup();
    }
  },
);

async function foreignReplacement(path: string, kind: "file" | "socket") {
  await unlink(path);
  let peer: Server | undefined;
  if (kind === "file") {
    await writeFile(path, "foreign replacement", { mode: 0o600 });
  } else {
    peer = createServer((socket) => socket.end("foreign listener alive"));
    await deadline(
      new Promise<void>((resolve, reject) => {
        peer!.once("error", reject);
        peer!.listen(path, resolve);
      }),
      1000,
      "foreign-listener-bind",
    );
    await chmod(path, 0o600);
  }
  const identity = await lstat(path);
  return {
    identity,
    async verify() {
      const current = await lstat(path);
      expect(current.ino).toBe(identity.ino);
      expect(current.dev).toBe(identity.dev);
      if (kind === "file")
        expect(await readFile(path, "utf8")).toBe("foreign replacement");
      else {
        expect(current.isSocket()).toBe(true);
        const socket = createConnection({ path });
        try {
          const value = await deadline(
            new Promise<string>((resolve, reject) => {
              socket.once("data", (data) => resolve(data.toString()));
              socket.once("error", reject);
            }),
            1000,
            "foreign-listener-connect",
          );
          expect(value).toBe("foreign listener alive");
        } finally {
          socket.destroy();
        }
      }
    },
    async close() {
      if (peer)
        await deadline(
          new Promise<void>((resolve) => peer!.close(() => resolve())),
          1000,
          "foreign-listener-close",
        );
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

test.each(["file", "socket"] as const)(
  "RPC close preserves a foreign replacement %s inode and retires its own listener",
  async (kind) => {
    const root = await mkdtemp("/tmp/gnw-ms-rpc-replacement-");
    const service = await startManagerSessionServer({
      controller: emptyController(root),
      directory: join(root, "private"),
    });
    let replacement: Awaited<ReturnType<typeof foreignReplacement>> | undefined;
    try {
      const own = await lstat(service.descriptor.endpoint);
      replacement = await foreignReplacement(service.descriptor.endpoint, kind);
      expect(replacement.identity.ino).not.toBe(own.ino);
      await deadline(service.close(), 3000, "rpc-replacement-close");
      await replacement.verify();
      await expect(lstat(service.descriptorPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await service.close().catch(() => {});
      await replacement?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["file", "socket"] as const)(
  "actual native lease release preserves a foreign proxy replacement %s inode",
  async (kind) => {
    const f = await nativeFixture();
    let replacement: Awaited<ReturnType<typeof foreignReplacement>> | undefined;
    try {
      await f.controller.load(f.profile.path);
      const a = await acquire(f);
      const own = await lstat(a.gdbEndpoint);
      replacement = await foreignReplacement(a.gdbEndpoint, kind);
      expect(replacement.identity.ino).not.toBe(own.ino);
      expect(
        await a.p.call("release", {
          sessionId: a.sessionId,
          leaseId: a.leaseId,
          completion,
        }),
      ).toMatchObject({
        ok: true,
        result: { session: { execution: "running" } },
      });
      await replacement.verify();
    } finally {
      await replacement?.close();
      await f.cleanup();
    }
  },
);
