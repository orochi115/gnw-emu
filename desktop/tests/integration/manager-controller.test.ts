import { expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
  readdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { createConnection, createServer } from "node:net";
import { deadline } from "../../src/core/session-controller";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import * as kernel from "../../src/core/kernel-backend";
import { SessionController } from "../../src/core/session-controller";
import { createProfile } from "../../src/core/profile-store";
import { createDisplayReceiver } from "../../src/display/receiver";
import { createLogManager } from "../../src/observability/logger";

const binary = resolve(
  process.env.GWEMU_DESKTOP_BINARY ??
    "../build/gwemu/qemu-system-arm",
);
const complete = {
  success: true,
  managerUploaded: false,
  memoryWritten: false,
  executionChanged: false,
};
function owner(
  operation: "read" | "manage" | "debug" = "manage",
  duration = 10000,
) {
  const abort = new AbortController();
  return {
    token: {
      operation,
      deadlineMs: Date.now() + duration,
      signal: abort.signal,
    },
    abort,
  };
}
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}
async function rsp(path: string) {
  const socket = createConnection({ path });
  let buffer = "";
  let pending:
    | { resolve: (value: string) => void; reject: (error: Error) => void }
    | undefined;
  socket.on("data", (chunk) => {
    buffer += chunk.toString("ascii");
    const match = /\$([^#]*)#([0-9a-f]{2})/i.exec(buffer);
    if (!match || !pending) return;
    buffer = buffer.slice(match.index + match[0].length);
    const checksum =
      [...match[1]].reduce((total, char) => total + char.charCodeAt(0), 0) &
      255;
    if (checksum !== parseInt(match[2], 16))
      pending.reject(new Error("Invalid RSP checksum"));
    else {
      socket.write("+");
      pending.resolve(match[1]);
    }
    pending = undefined;
  });
  socket.on("error", (error) => pending?.reject(error));
  await deadline(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    1000,
    "gdb-connect",
  );
  return {
    async command(payload: string) {
      const reply = new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
      });
      const sum =
        [...payload].reduce((total, char) => total + char.charCodeAt(0), 0) &
        255;
      socket.write(`$${payload}#${sum.toString(16).padStart(2, "0")}`);
      return deadline(reply, 1000, "gdb-frame");
    },
    async close() {
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
      socket.destroy();
      await deadline(closed, 1000, "gdb-close");
    },
  };
}
async function pc(path: string) {
  const client = await rsp(path);
  try {
    const registers = await client.command("g");
    expect(registers).toMatch(/^[0-9a-f]{128,}$/i);
    return Buffer.from(registers.slice(15 * 8, 16 * 8), "hex").readUInt32LE();
  } finally {
    await client.close();
  }
}
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  await deadline(
    (async () => {
      while (!(await predicate())) await new Promise((r) => setTimeout(r, 5));
    })(),
    2000,
    "observation",
  );
}
async function fixture(displayReady?: Promise<void>) {
  expect(
    existsSync(binary),
    "required clean session-manager native is missing",
  ).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "gnw-manager-controller-"));
  const sockets = await mkdtemp("/tmp/gnw-mc-");
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
  const internal = Buffer.alloc(128 * 1024, 0xff);
  (await readFile(join(root, "guest.bin"))).copy(internal);
  const external = Buffer.alloc(1024 * 1024, 0x37);
  await writeFile(join(root, "internal.bin"), internal);
  await writeFile(join(root, "external.bin"), external);
  const profile = await createProfile(join(root, "test.gnw.json"), {
    model: "mario",
    internalFlash: join(root, "internal.bin"),
    externalFlash: join(root, "external.bin"),
  });
  let qtestPath = "";
  const originalArgs = kernel.kernelArguments;
  const adapter = vi
    .spyOn(kernel, "kernelArguments")
    .mockImplementation(async (...options) => {
      qtestPath = join(sockets, "q.sock");
      return [
        ...(await originalArgs(...options)),
        "-qtest",
        `unix:${qtestPath},server=on,wait=off`,
        "-qtest-log",
        "/dev/null",
      ];
    });
  const controller = new SessionController({
    kernel: "gwemu",
    qemu: binary,
    userData: join(root, "data"),
    managerDirectory: join(sockets, "private"),
    logger: createLogManager({
      appInstanceId: "manager-controller",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: async () => {
      const display = await createDisplayReceiver(() => {});
      return displayReady ? { ...display, ready: displayReady } : display;
    },
    timeout: 3000,
  });
  const children = new Set<number>();
  controller.on("state", () => {
    const pid = controller.diagnostics().qemuPid;
    if (pid) children.add(pid);
  });
  async function hardware(commands: string[]) {
    const socket = createConnection({ path: qtestPath });
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
      const values = [];
      for (const command of commands) {
        socket.write(command + "\n");
        const reply = (await deadline(lines.next(), 1000, "qtest-frame"))
          .value!;
        expect(reply).toMatch(/^OK/);
        values.push(Number(reply.slice(2).trim()));
      }
      return values;
    } finally {
      reader.close();
      socket.destroy();
    }
  }
  async function cleanup() {
    await deadline(
      controller.stop().catch(() => {}),
      10000,
      "fixture-stop",
    );
    adapter.mockRestore();
    for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
    expect(await readFile(profile.internalFlash)).toEqual(internal);
    expect(await readFile(profile.externalFlash)).toEqual(external);
    await rm(sockets, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
  return { controller, profile, hardware, cleanup, root, sockets };
}

test("admission closes UI gates synchronously and raw paused release preserves native state", async () => {
  const f = await fixture();
  const c = f.controller;
  try {
    expect(c.managerSession()).toBeUndefined();
    await c.load(f.profile.path);
    await c.deviceAction("device.pause");
    const initial = await f.hardware(["readl 0x2000010c"]);
    const gate = defer();
    const entered = defer();
    const original = kernel.KernelBackend.prototype.readDeviceState;
    const blocked = vi
      .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
      .mockImplementation(async function (this: kernel.KernelBackend) {
        entered.resolve();
        await gate.promise;
        return original.call(this);
      });
    const o = owner();
    const acquiring = c.beginManager(c.managerSession()!.sessionId, o.token);
    acquiring.catch(() => {});
    await entered.promise;
    await expect(c.load(f.profile.path)).rejects.toThrow();
    await expect(c.setMuted(true)).rejects.toThrow();
    c.key("ArrowLeft", true);
    await c.instantState("save");
    expect(c.inputState().desiredMask).toBe(0);
    gate.resolve();
    const acquired = await acquiring;
    blocked.mockRestore();
    expect(acquired.initial.execution).toBe("paused");
    expect((await lstat(acquired.gdbEndpoint)).mode & 0o777).toBe(0o600);
    expect(await f.hardware(["readl 0x2000010c"])).toEqual(initial);
    const initialPc = await pc(acquired.gdbEndpoint);
    const released = await c.endManager(o.token, complete);
    expect(released.session.execution).toBe("paused");
    expect(await pc(acquired.gdbEndpoint)).toBe(initialPc);
    expect(await f.hardware(["readl 0x2000010c"])).toEqual(initial);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test.each(["running", "paused"] as const)(
  "press guest observes both edges from %s and release preserves explicit intent",
  async (execution) => {
    const f = await fixture();
    const c = f.controller;
    try {
      await c.load(f.profile.path);
      if (execution === "paused") await c.deviceAction("device.pause");
      const o = owner();
      await c.beginManager(c.managerSession()!.sessionId, o.token);
      const before = await f.hardware(["readl 0x20000100", "readl 0x20000104"]);
      await c.managerControl(o.token, {
        action: "press",
        value: { mask: 1, durationMs: 50 },
      });
      const after = await f.hardware(["readl 0x20000100", "readl 0x20000104"]);
      expect(after[0]).toBeGreaterThan(before[0]);
      expect(after[1]).toBeGreaterThan(before[1]);
      expect(c.managerSession()!.execution).toBe("paused");
      await c.managerControl(o.token, {
        action: execution === "running" ? "pause" : "resume",
      });
      const result = await c.endManager(o.token, complete);
      expect(result.session.execution).toBe(
        execution === "running" ? "paused" : "running",
      );
    } finally {
      await f.cleanup();
    }
  },
);

test("real GDB writes are marked unsafe and successful release resets into bank1", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    await f.controller.deviceAction("device.pause");
    const o = owner();
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const client = await rsp(acquired.gdbEndpoint);
    try {
      f.controller.markManager(o.token, {
        managerUploaded: true,
        memoryWritten: true,
        executionChanged: true,
      });
      expect(await client.command("M20000200,4:fee700bf")).toBe("OK");
      expect(await client.command("Pf=01020020")).toBe("OK");
      expect(await client.command("P0=78563412")).toBe("OK");
      expect(await client.command("m20000200,4")).toBe("fee700bf");
    } finally {
      await client.close();
    }
    expect(await pc(acquired.gdbEndpoint)).toBe(0x20000200);
    await expect(
      f.controller.managerControl(o.token, {
        action: "press",
        value: { mask: 1, durationMs: 20 },
      }),
    ).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
    const released = await f.controller.endManager(o.token, complete);
    expect(released.session.execution).toBe("paused");
    expect(await pc(acquired.gdbEndpoint)).toBe(0x08000008);
  } finally {
    await f.cleanup();
  }
});

test("raw running release and explicit execution controls retain RAM without reset", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    expect(acquired.initial.execution).toBe("running");
    await f.hardware(["writel 0x20000108 0", "writel 0x20000210 0x12345678"]);
    expect(
      (await f.controller.endManager(o.token, complete)).session.execution,
    ).toBe("running");
    expect(await f.hardware(["readl 0x20000210"])).toEqual([0x12345678]);
    const paused = owner();
    const second = await f.controller.beginManager(
      acquired.sessionId,
      paused.token,
    );
    await f.controller.managerControl(paused.token, { action: "pause" });
    const savedPc = await pc(second.gdbEndpoint);
    expect(
      (await f.controller.endManager(paused.token, complete)).session.execution,
    ).toBe("paused");
    expect(await pc(second.gdbEndpoint)).toBe(savedPc);
    const resumed = owner();
    await f.controller.beginManager(acquired.sessionId, resumed.token);
    await f.controller.managerControl(resumed.token, { action: "resume" });
    expect(
      (await f.controller.endManager(resumed.token, complete)).session
        .execution,
    ).toBe("running");
    expect(await f.hardware(["readl 0x20000210"])).toEqual([0x12345678]);
  } finally {
    await f.cleanup();
  }
});

test("read and wrong owners cannot control, debug requires reset, and unpowered release never runs", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const reading = owner("read");
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      reading.token,
    );
    await expect(
      f.controller.managerControl(reading.token, { action: "pause" }),
    ).rejects.toMatchObject({ code: "NOT_OWNER" });
    await expect(
      f.controller.endManager(owner().token, complete),
    ).rejects.toMatchObject({ code: "NOT_OWNER" });
    await f.controller.endManager(reading.token, complete);
    const debugging = owner("debug");
    await f.controller.beginManager(acquired.sessionId, debugging.token);
    await expect(
      f.controller.managerControl(debugging.token, { action: "resume" }),
    ).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
    await f.controller.managerControl(debugging.token, {
      action: "warm-reset",
    });
    await f.controller.managerControl(debugging.token, {
      action: "press",
      value: { mask: 1, durationMs: 10 },
    });
    await f.controller.managerControl(debugging.token, {
      action: "usb-power",
      value: false,
    });
    await f.controller.managerControl(debugging.token, {
      action: "battery-present",
      value: false,
    });
    await expect(
      f.controller.managerControl(debugging.token, { action: "resume" }),
    ).rejects.toMatchObject({ code: "NO_POWER" });
    expect(
      (await f.controller.endManager(debugging.token, complete)).session
        .execution,
    ).toBe("unpowered");
  } finally {
    await f.cleanup();
  }
});

test("abort during press releases host keys without later cont and requires close/reopen", async () => {
  const f = await fixture();
  const commands: string[] = [];
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const qmp = (await import("../../src/core/qmp-client")).QmpClient;
    const original = qmp.prototype.command;
    const spy = vi.spyOn(qmp.prototype, "command").mockImplementation(function (
      this: InstanceType<typeof qmp>,
      ...args
    ) {
      commands.push(args[0]);
      return original.apply(this, args);
    });
    const before = (await f.hardware(["readl 0x20000100"]))[0];
    const pressing = f.controller.managerControl(o.token, {
      action: "press",
      value: { mask: 1, durationMs: 1000 },
    });
    pressing.catch(() => {});
    await waitUntil(
      async () => (await f.hardware(["readl 0x20000100"]))[0] > before,
    );
    const boundary = commands.length;
    o.abort.abort();
    await expect(pressing).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await waitUntil(
      () => f.controller.managerSession()?.execution === "unknown",
    );
    expect(commands.slice(boundary)).not.toContain("cont");
    expect(await f.hardware(["readl 0x58020c10"])).toEqual([0xffff]);
    await expect(
      f.controller.beginManager(acquired.sessionId, owner().token),
    ).rejects.toMatchObject({ code: "UNCERTAIN" });
    spy.mockRestore();
    await expect(f.controller.stop()).rejects.toThrow();
    await f.controller.load(f.profile.path);
    expect(f.controller.managerSession()!.sessionId).not.toBe(
      acquired.sessionId,
    );
    await expect(
      f.controller.beginManager(acquired.sessionId, owner().token),
    ).rejects.toMatchObject({ code: "STALE_SESSION" });
    expect(f.controller.managerSession()!.execution).toBe("running");
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("absolute deadline expires a lease and stop revokes the owner and cleans its socket", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const expiring = owner("manage", 150);
    await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      expiring.token,
    );
    await waitUntil(
      () => f.controller.managerSession()?.execution === "unknown",
    );
    await expect(f.controller.stop()).rejects.toThrow();
    await f.controller.load(f.profile.path);
    const o = owner();
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const events: unknown[] = [];
    f.controller.on("manager-revoke", (event) => events.push(event));
    await expect(f.controller.stop()).rejects.toThrow();
    expect(events).toEqual([{ sessionId: acquired.sessionId, owner: o.token }]);
    expect(existsSync(acquired.gdbEndpoint)).toBe(false);
    expect(f.controller.managerSession()).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("admission waits accepted power and snapshot work before capturing initial execution", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const gate = defer();
    const entered = defer();
    const original = kernel.KernelBackend.prototype.readDeviceState;
    const blocked = vi
      .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
      .mockImplementation(async function (this: kernel.KernelBackend, timeout) {
        entered.resolve();
        await gate.promise;
        return original.call(this, timeout);
      });
    const powering = f.controller.deviceAction("device.pause");
    await deadline(entered.promise, 1000, "power-enter");
    const o = owner();
    let acquired = false;
    const acquiring = f.controller
      .beginManager(f.controller.managerSession()!.sessionId, o.token)
      .then((value) => {
        acquired = true;
        return value;
      });
    expect(f.controller.state.deviceOperation).toBe(true);
    expect(acquired).toBe(false);
    gate.resolve();
    await powering;
    expect(f.controller.state.deviceOperation).toBe(true);
    expect((await acquiring).initial.execution).toBe("paused");
    blocked.mockRestore();
    await f.controller.endManager(o.token, complete);
    const stateGate = defer();
    const stateEntered = defer();
    const qmp = (await import("../../src/core/qmp-client")).QmpClient;
    const command = qmp.prototype.command;
    const snapshot = vi
      .spyOn(qmp.prototype, "command")
      .mockImplementation(async function (
        this: InstanceType<typeof qmp>,
        ...args
      ) {
        if (
          args[0] === "qom-get" &&
          args[1]?.property === "savestate-support"
        ) {
          stateEntered.resolve();
          await stateGate.promise;
        }
        return command.apply(this, args);
      });
    const saved = f.controller.instantState("save");
    await deadline(stateEntered.promise, 1000, "state-enter");
    const next = owner();
    const pending = f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      next.token,
    );
    pending.catch(() => {});
    stateGate.resolve();
    await saved;
    expect((await pending).initial.execution).toBe("paused");
    snapshot.mockRestore();
    await f.controller.endManager(next.token, complete);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("stop races successful release without continuing or publishing a stale session", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const gate = defer();
    const entered = defer();
    const original = kernel.KernelBackend.prototype.readDeviceState;
    const blocked = vi
      .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
      .mockImplementation(async function (this: kernel.KernelBackend, timeout) {
        entered.resolve();
        await gate.promise;
        return original.call(this, timeout);
      });
    const releasing = f.controller.endManager(o.token, complete);
    releasing.catch(() => {});
    await deadline(entered.promise, 1000, "release-enter");
    const stopping = f.controller.stop();
    stopping.catch(() => {});
    gate.resolve();
    await expect(releasing).rejects.toMatchObject({ code: "STALE_SESSION" });
    await expect(stopping).rejects.toThrow();
    blocked.mockRestore();
    await f.controller.load(f.profile.path);
    expect(f.controller.managerSession()!.execution).toBe("running");
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("an owned native child exit revokes management and cleans its private endpoint", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const events: unknown[] = [];
    f.controller.on("manager-revoke", (event) => events.push(event));
    process.kill(f.controller.diagnostics().qemuPid!, "SIGTERM");
    await waitUntil(() => f.controller.diagnostics().qemuPid === undefined);
    expect(events).toEqual([{ sessionId: acquired.sessionId, owner: o.token }]);
    expect(existsSync(acquired.gdbEndpoint)).toBe(false);
    expect(f.controller.state.saveUncertain).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("failed release after cont stops native execution before marking uncertainty", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const original = kernel.KernelBackend.prototype.readDeviceState;
    let reads = 0;
    const blocked = vi
      .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
      .mockImplementation(async function (this: kernel.KernelBackend, timeout) {
        if (++reads === 2) throw new Error("post-cont release read failed");
        return original.call(this, timeout);
      });
    await expect(f.controller.endManager(o.token, complete)).rejects.toThrow(
      "post-cont release read failed",
    );
    blocked.mockRestore();
    expect(f.controller.managerSession()!.execution).toBe("unknown");
    const heartbeat = await f.hardware(["readl 0x2000010c"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await f.hardware(["readl 0x2000010c"])).toEqual(heartbeat);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("admission abort cannot let an already accepted resume continue later", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    await f.controller.deviceAction("device.pause");
    const gate = defer();
    const entered = defer();
    const original = kernel.KernelBackend.prototype.readDeviceState;
    let first = true;
    const blocked = vi
      .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
      .mockImplementation(async function (this: kernel.KernelBackend, timeout) {
        if (first) {
          first = false;
          entered.resolve();
          await gate.promise;
        }
        return original.call(this, timeout);
      });
    const accepted = f.controller.deviceAction("device.resume");
    await deadline(entered.promise, 1000, "resume-enter");
    const o = owner();
    const admission = f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    admission.catch(() => {});
    o.abort.abort();
    await expect(admission).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(f.controller.managerSession()!.execution).toBe("unknown");
    gate.resolve();
    await accepted;
    blocked.mockRestore();
    expect(f.controller.managerSession()!.execution).toBe("unknown");
    const heartbeat = await f.hardware(["readl 0x2000010c"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await f.hardware(["readl 0x2000010c"])).toEqual(heartbeat);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("restoring a source does not run until cold-start restores the application", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const o = owner("debug");
    await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    f.controller.markManager(o.token, {
      managerUploaded: false,
      memoryWritten: true,
      executionChanged: false,
    });
    await f.hardware(["writel 0x20000210 0x12345678"]);
    await f.controller.managerControl(o.token, {
      action: "usb-power",
      value: false,
    });
    await f.controller.managerControl(o.token, {
      action: "battery-present",
      value: false,
    });
    await expect(
      f.controller.managerControl(o.token, { action: "cold-start" }),
    ).rejects.toMatchObject({ code: "NO_POWER" });
    await f.controller.managerControl(o.token, {
      action: "usb-power",
      value: true,
    });
    expect(f.controller.managerSession()!.execution).toBe("paused");
    await f.controller.managerControl(o.token, { action: "cold-start" });
    expect(f.controller.managerSession()!.execution).toBe("running");
    expect(await f.hardware(["readl 0x20000210"])).toEqual([0]);
    expect(
      (await f.controller.endManager(o.token, complete)).session.execution,
    ).toBe("running");
  } finally {
    await f.cleanup();
  }
});

test.each(["abort", "deadline"] as const)(
  "%s during release prevents restoration from continuing native execution",
  async (mode) => {
    const f = await fixture();
    try {
      await f.controller.load(f.profile.path);
      const o = owner("manage", 300);
      await f.controller.beginManager(
        f.controller.managerSession()!.sessionId,
        o.token,
      );
      const gate = defer();
      const entered = defer();
      const original = kernel.KernelBackend.prototype.readDeviceState;
      let first = true;
      const blocked = vi
        .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
        .mockImplementation(async function (
          this: kernel.KernelBackend,
          timeout,
        ) {
          if (first) {
            first = false;
            entered.resolve();
            await gate.promise;
          }
          return original.call(this, timeout);
        });
      const release = f.controller.endManager(o.token, complete);
      release.catch(() => {});
      await deadline(entered.promise, 1000, "restore-enter");
      if (mode === "abort") o.abort.abort();
      else await waitUntil(() => Date.now() > o.token.deadlineMs);
      gate.resolve();
      await expect(release).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
      blocked.mockRestore();
      expect(f.controller.managerSession()!.execution).toBe("unknown");
      const heartbeat = await f.hardware(["readl 0x2000010c"]);
      await new Promise((r) => setTimeout(r, 20));
      expect(await f.hardware(["readl 0x2000010c"])).toEqual(heartbeat);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);

test.each(["warm-reset", "cold-start"] as const)(
  "%s cannot overwrite a newer synchronous GDB mutation marker",
  async (action) => {
    const f = await fixture();
    const gate = defer();
    try {
      await f.controller.load(f.profile.path);
      const o = owner();
      const acquired = await f.controller.beginManager(
        f.controller.managerSession()!.sessionId,
        o.token,
      );
      const entered = defer();
      const qmp = (await import("../../src/core/qmp-client")).QmpClient;
      const original = qmp.prototype.command;
      const afterMark: string[] = [];
      let resetSeen = false,
        stopSeen = false,
        marked = false;
      const spy = vi
        .spyOn(qmp.prototype, "command")
        .mockImplementation(async function (
          this: InstanceType<typeof qmp>,
          ...args
        ) {
          if (marked) afterMark.push(args[0]);
          const value = await original.apply(this, args);
          if (
            args[0] === "system_reset" ||
            (args[0] === "human-monitor-command" &&
              args[1]?.["command-line"] === "gnw-cold-cycle")
          )
            resetSeen = true;
          if (args[0] === "stop" && resetSeen) stopSeen = true;
          if (args[0] === "query-status" && stopSeen) {
            stopSeen = false;
            resetSeen = false;
            entered.resolve();
            await gate.promise;
          }
          return value;
        });
      const reset = f.controller.managerControl(o.token, { action });
      reset.catch(() => {});
      await deadline(entered.promise, 1000, "native-reset-stopped");
      f.controller.markManager(o.token, {
        managerUploaded: false,
        memoryWritten: true,
        executionChanged: true,
      });
      marked = true;
      const client = await rsp(acquired.gdbEndpoint);
      try {
        expect(await client.command("M20000200,4:fee700bf")).toBe("OK");
        expect(await client.command("Pf=01020020")).toBe("OK");
      } finally {
        await client.close();
      }
      gate.resolve();
      if (action === "cold-start")
        await expect(reset).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
      else await reset;
      expect(afterMark).not.toContain("cont");
      expect(await pc(acquired.gdbEndpoint)).toBe(0x20000200);
      await expect(
        f.controller.managerControl(o.token, { action: "resume" }),
      ).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
      await expect(
        f.controller.managerControl(o.token, {
          action: "press",
          value: { mask: 1, durationMs: 10 },
        }),
      ).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
      spy.mockRestore();
      await f.controller.endManager(o.token, complete);
    } finally {
      gate.resolve();
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);

test.each(["crash", "cancel"] as const)(
  "startup %s after native socket bind but before display readiness leaves no owned endpoint",
  async (mode) => {
    const held = defer();
    const f = await fixture(held.promise);
    let loading: Promise<void> | undefined;
    try {
      loading = f.controller.load(f.profile.path);
      loading.catch(() => {});
      await waitUntil(
        async () =>
          !!f.controller.diagnostics().qemuPid &&
          (await readdir(join(f.sockets, "private")).catch(() => [])).some(
            (name) => name.endsWith(".sock"),
          ),
      );
      if (mode === "crash")
        process.kill(f.controller.diagnostics().qemuPid!, "SIGKILL");
      else await f.controller.stop().catch(() => {});
      await expect(loading).rejects.toThrow();
      expect(await readdir(join(f.sockets, "private"))).toEqual([]);
    } finally {
      held.resolve();
      await loading?.catch(() => {});
      await f.cleanup();
    }
  },
);

test("startup cleanup preserves a replacement inode at the claimed native socket path", async () => {
  const held = defer();
  const f = await fixture(held.promise);
  const replacement = createServer((socket) => socket.destroy());
  let loading: Promise<void> | undefined;
  try {
    loading = f.controller.load(f.profile.path);
    loading.catch(() => {});
    let socketPath = "";
    await waitUntil(async () => {
      const name = (
        await readdir(join(f.sockets, "private")).catch(() => [])
      ).find((name) => name.endsWith(".sock"));
      if (!name) return false;
      socketPath = join(f.sockets, "private", name);
      return ((await lstat(socketPath)).mode & 0o777) === 0o600;
    });
    const previous = await lstat(socketPath);
    await unlink(socketPath);
    await deadline(
      new Promise<void>((resolve, reject) => {
        replacement.once("error", reject);
        replacement.listen(socketPath, resolve);
      }),
      1000,
      "replacement-listen",
    );
    const changed = await lstat(socketPath);
    expect([changed.dev, changed.ino]).not.toEqual([
      previous.dev,
      previous.ino,
    ]);
    process.kill(f.controller.diagnostics().qemuPid!, "SIGKILL");
    await expect(loading).rejects.toThrow();
    const retained = await lstat(socketPath);
    expect([retained.dev, retained.ino]).toEqual([changed.dev, changed.ino]);
  } finally {
    held.resolve();
    await loading?.catch(() => {});
    if (replacement.listening)
      await deadline(
        new Promise<void>((resolve, reject) =>
          replacement.close((error) => (error ? reject(error) : resolve())),
        ),
        1000,
        "replacement-close",
      );
    await f.cleanup();
  }
});

test("accepted press excludes pre-GDB mutation while awaiting its first running confirmation", async () => {
  const f = await fixture();
  const gate = defer();
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    const acquired = await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const entered = defer();
    const qmp = (await import("../../src/core/qmp-client")).QmpClient;
    const original = qmp.prototype.command;
    let contSeen = false;
    const spy = vi
      .spyOn(qmp.prototype, "command")
      .mockImplementation(async function (
        this: InstanceType<typeof qmp>,
        ...args
      ) {
        const value = await original.apply(this, args);
        if (args[0] === "cont") contSeen = true;
        else if (args[0] === "query-status" && contSeen) {
          contSeen = false;
          entered.resolve();
          await gate.promise;
        }
        return value;
      });
    const pressing = f.controller.managerControl(o.token, {
      action: "press",
      value: { mask: 1, durationMs: 30 },
    });
    pressing.catch(() => {});
    expect(() =>
      f.controller.markManager(o.token, {
        managerUploaded: false,
        memoryWritten: true,
        executionChanged: true,
      }),
    ).toThrow(expect.objectContaining({ code: "BUSY" }));
    await deadline(entered.promise, 1000, "press-confirmation");
    let writes = 0;
    expect(() => {
      f.controller.markManager(o.token, {
        managerUploaded: false,
        memoryWritten: true,
        executionChanged: true,
      });
      writes++;
    }).toThrow(expect.objectContaining({ code: "BUSY" }));
    expect(writes).toBe(0);
    gate.resolve();
    await pressing;
    spy.mockRestore();
    expect(f.controller.managerSession()!.execution).toBe("paused");
    expect(await f.hardware(["readl 0x58020c10"])).toEqual([0xffff]);
    // Once the execution control is settled, a successful marker admits real
    // GDB mutation, and an authoritative reset restores safe application input.
    f.controller.markManager(o.token, {
      managerUploaded: false,
      memoryWritten: true,
      executionChanged: true,
    });
    const client = await rsp(acquired.gdbEndpoint);
    try {
      expect(await client.command("M20000200,4:fee700bf")).toBe("OK");
      expect(await client.command("Pf=01020020")).toBe("OK");
    } finally {
      await client.close();
    }
    await expect(
      f.controller.managerControl(o.token, { action: "resume" }),
    ).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
    await f.controller.managerControl(o.token, { action: "warm-reset" });
    await f.controller.managerControl(o.token, {
      action: "press",
      value: { mask: 1, durationMs: 10 },
    });
    await f.controller.endManager(o.token, complete);
  } finally {
    gate.resolve();
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("held press excludes pre-GDB mark and cancellation still clears host input without cont", async () => {
  const f = await fixture();
  try {
    await f.controller.load(f.profile.path);
    const o = owner();
    await f.controller.beginManager(
      f.controller.managerSession()!.sessionId,
      o.token,
    );
    const qmp = (await import("../../src/core/qmp-client")).QmpClient;
    const original = qmp.prototype.command;
    const commands: string[] = [];
    const spy = vi.spyOn(qmp.prototype, "command").mockImplementation(function (
      this: InstanceType<typeof qmp>,
      ...args
    ) {
      commands.push(args[0]);
      return original.apply(this, args);
    });
    const before = (await f.hardware(["readl 0x20000100"]))[0];
    const pressing = f.controller.managerControl(o.token, {
      action: "press",
      value: { mask: 1, durationMs: 1000 },
    });
    pressing.catch(() => {});
    await waitUntil(
      async () => (await f.hardware(["readl 0x20000100"]))[0] > before,
    );
    expect(() =>
      f.controller.markManager(o.token, {
        managerUploaded: false,
        memoryWritten: true,
        executionChanged: true,
      }),
    ).toThrow(expect.objectContaining({ code: "BUSY" }));
    const boundary = commands.length;
    o.abort.abort();
    await expect(deadline(pressing, 500, "press-cancel")).rejects.toMatchObject(
      { code: "LEASE_EXPIRED" },
    );
    await waitUntil(
      () => f.controller.managerSession()?.execution === "unknown",
    );
    expect(await f.hardware(["readl 0x58020c10"])).toEqual([0xffff]);
    expect(commands.slice(boundary)).not.toContain("cont");
    expect(commands.slice(boundary)).not.toContain("input-send-event");
    spy.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test.each(["resume", "cold-start"] as const)(
  "%s completion excludes newer pre-GDB mutation until execution intent is confirmed",
  async (action) => {
    const f = await fixture();
    const gate = defer();
    try {
      await f.controller.load(f.profile.path);
      const o = owner();
      await f.controller.beginManager(
        f.controller.managerSession()!.sessionId,
        o.token,
      );
      const entered = defer();
      const qmp = (await import("../../src/core/qmp-client")).QmpClient;
      const original = qmp.prototype.command;
      let continued = false;
      const spy = vi
        .spyOn(qmp.prototype, "command")
        .mockImplementation(async function (
          this: InstanceType<typeof qmp>,
          ...args
        ) {
          const value = await original.apply(this, args);
          if (args[0] === "cont") continued = true;
          else if (args[0] === "query-status" && continued) {
            continued = false;
            entered.resolve();
            await gate.promise;
          }
          return value;
        });
      const executing = f.controller.managerControl(o.token, { action });
      executing.catch(() => {});
      await deadline(entered.promise, 1000, "intent-confirmation");
      expect(() =>
        f.controller.markManager(o.token, {
          managerUploaded: false,
          memoryWritten: true,
          executionChanged: true,
        }),
      ).toThrow(expect.objectContaining({ code: "BUSY" }));
      gate.resolve();
      await executing;
      spy.mockRestore();
      expect(
        (await f.controller.endManager(o.token, complete)).session.execution,
      ).toBe("running");
    } finally {
      gate.resolve();
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);
