import { expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import * as kernel from "../../src/core/kernel-backend";
import { createProfile } from "../../src/core/profile-store";
import { SessionController, deadline } from "../../src/core/session-controller";
import { QmpClient } from "../../src/core/qmp-client";
import { createDisplayReceiver } from "../../src/display/receiver";
import { createLogManager } from "../../src/observability/logger";

const binary = resolve(
  process.env.GWEMU_DESKTOP_BINARY ??
    "../build/gwemu-savestate/qemu-system-arm",
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gnw-supply-controller-"));
  const sockets = await mkdtemp("/tmp/gnw-supply-qtest-");
  let qtestPath = "",
    generation = 0;
  const realArgs = kernel.kernelArguments;
  const args = vi
    .spyOn(kernel, "kernelArguments")
    .mockImplementation(async (...options) => {
      qtestPath = join(sockets, `${++generation}.sock`);
      return [
        ...(await realArgs(...options)),
        "-qtest",
        `unix:${qtestPath},server=on,wait=off`,
        "-qtest-log",
        "/dev/null",
      ];
    });
  const hardware = async (commands: string[]) => {
    const socket = createConnection({ path: qtestPath });
    const reader = createInterface({ input: socket });
    const lines = reader[Symbol.asyncIterator]();
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const values = [];
      for (const command of commands) {
        socket.write(command + "\n");
        const reply = (await lines.next()).value!;
        expect(reply).toMatch(/^OK/);
        values.push(Number(reply.slice(2).trim()));
      }
      return values;
    } finally {
      reader.close();
      socket.destroy();
    }
  };
  const internal = Buffer.alloc(128 * 1024, 0xff);
  internal.writeUInt32LE(0x20020000, 0);
  internal.writeUInt32LE(0x08000009, 4);
  internal[8] = 0xfe;
  internal[9] = 0xe7;
  const external = Buffer.alloc(1024 * 1024, 0x37);
  await writeFile(join(root, "internal.bin"), internal);
  await writeFile(join(root, "external.bin"), external);
  const profile = await createProfile(join(root, "test.gnw.json"), {
    model: "mario",
    internalFlash: join(root, "internal.bin"),
    externalFlash: join(root, "external.bin"),
  });
  let displayClosed = false;
  const controller = new SessionController({
    kernel: "gwemu",
    qemu: binary,
    userData: join(root, "data"),
    logger: createLogManager({
      appInstanceId: "supply-test",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: async () => {
      const display = await createDisplayReceiver(() => {});
      const close = display.close;
      display.close = async () => {
        await close();
        displayClosed = true;
      };
      return display;
    },
    timeout: 3000,
  });
  const directory = join(
    root,
    "data",
    "kernels",
    "gwemu",
    "sessions",
    profile.id,
  );
  const metadata = join(directory, "session.json");
  const cleanup = async () => {
    await controller.stop().catch(() => {});
    expect(await readFile(profile.internalFlash)).toEqual(internal);
    expect(await readFile(profile.externalFlash)).toEqual(external);
    args.mockRestore();
    await rm(sockets, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  };
  return {
    root,
    profile,
    controller,
    hardware,
    metadata,
    cleanup,
    displayClosed: () => displayClosed,
  };
}

test.skipIf(!existsSync(binary))(
  "native supply controller pauses, loses volatile state, reopens off and cold starts",
  async () => {
    const f = await fixture();
    const { controller: c, hardware: hw } = f;
    try {
      await c.load(f.profile.path);
      expect(c.state.execution).toBe("running");
      c.key("ArrowLeft", true);
      await c.flushInput();
      await c.deviceAction("device.pause");
      expect(c.state.execution).toBe("paused");
      expect(c.inputState().appliedMask).toBe(0);
      c.key("ArrowLeft", true);
      await c.flushInput();
      expect(c.inputState().desiredMask).toBe(0);
      await c.deviceAction("device.resume");
      await hw([
        "writel 0x20000100 0x12345678",
        "writel 0x5c00a100 0x98765432",
        "writel 0x08000100 0xabcdef12",
      ]);
      await c.deviceAction("device.usb");
      await c.deviceAction("device.batteryPresent");
      expect(c.state.execution).toBe("running");
      expect((await hw(["readl 0x20000100"]))[0]).toBe(0x12345678);
      c.key("ArrowLeft", true);
      await c.flushInput();
      await c.deviceAction("device.usb");
      expect(c.state.execution).toBe("unpowered");
      expect(c.inputState().appliedMask).toBe(0);
      expect(await hw(["readl 0x20000100", "readl 0x5c00a100"])).toEqual([
        0, 0,
      ]);
      await expect(c.deviceAction("device.resume")).rejects.toThrow();
      await c.stop();
      expect(JSON.parse(await readFile(f.metadata, "utf8"))).toMatchObject({
        batteryPresent: false,
        usbPower: false,
      });
      const command = vi.spyOn(QmpClient.prototype, "command");
      try {
        await c.load(f.profile.path); // no frame wait or cont when starting without power
        expect(c.state.execution).toBe("unpowered");
        expect(command.mock.calls.map((call) => call[0])).not.toContain("cont");
      } finally {
        command.mockRestore();
      }
      expect((await hw(["readl 0x08000100"]))[0]).toBe(0xabcdef12);
      await c.deviceAction("device.batteryPresent");
      expect(c.state.execution).toBe("paused");
      await c.deviceAction("device.resume");
      expect(c.state.execution).toBe("running");
      await hw(["writel 0x20000100 0xaaaa", "writel 0x5c00a100 0xbbbb"]);
      await c.deviceAction("device.coldStart");
      expect(c.state.execution).toBe("running");
      expect(await hw(["readl 0x20000100", "readl 0x5c00a100"])).toEqual([
        0, 0,
      ]);
      await c.stop();
    } finally {
      await f.cleanup();
    }
  },
  30000,
);

test.skipIf(!existsSync(binary))(
  "presence snapshot failure preserves metadata and shuts down child",
  async () => {
    const f = await fixture();
    try {
      await f.controller.load(f.profile.path);
      const before = await readFile(f.metadata);
      const pid = f.controller.diagnostics().qemuPid!;
      const real = QmpClient.prototype.command;
      const fault = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(function (
          this: QmpClient,
          name,
          parameters,
          timeout,
        ) {
          if (name === "qom-get" && parameters?.property === "battery-present")
            return Promise.resolve("invalid");
          return real.call(this, name, parameters, timeout);
        });
      try {
        await expect(f.controller.stop()).rejects.toThrow(
          "error.saveUncertain",
        );
        expect(f.controller.state.saveUncertain).toBe(true);
        expect(await readFile(f.metadata)).toEqual(before);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        fault.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "queued cold startup cannot continue a runtime after shutdown begins",
  async () => {
    const f = await fixture();
    try {
      await f.controller.load(f.profile.path);
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const realCold = kernel.KernelBackend.prototype.coldReset;
      const cold = vi
        .spyOn(kernel.KernelBackend.prototype, "coldReset")
        .mockImplementation(async function (this: kernel.KernelBackend) {
          entered();
          await blocked;
          return realCold.call(this);
        });
      const command = vi.spyOn(QmpClient.prototype, "command");
      try {
        const first = f.controller.deviceAction("device.coldStart");
        const queued = f.controller.deviceAction("device.resume");
        await deadline(ready, 3000, "test-ready");
        const stop = f.controller.stop();
        release();
        await Promise.all([first, queued, stop]);
        expect(command.mock.calls.map((call) => call[0])).not.toContain("cont");
        expect(f.controller.state.status).toBe("idle");
      } finally {
        cold.mockRestore();
        command.mockRestore();
        release();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "queued actions stay bound to old runtime during ROM replacement",
  async () => {
    const f = await fixture();
    try {
      await f.controller.load(f.profile.path);
      const oldId = f.controller.state.runtimeSessionId;
      const replacement = await createProfile(
        join(f.root, "replacement.gnw.json"),
        {
          model: "mario",
          internalFlash: f.profile.internalFlash,
          externalFlash: f.profile.externalFlash,
        },
      );
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const realCold = kernel.KernelBackend.prototype.coldReset;
      const cold = vi
        .spyOn(kernel.KernelBackend.prototype, "coldReset")
        .mockImplementation(async function (this: kernel.KernelBackend) {
          entered();
          await blocked;
          return realCold.call(this);
        });
      const command = vi.spyOn(QmpClient.prototype, "command");
      const updates: any[] = [];
      f.controller.on("state", (state) => updates.push(state));
      try {
        const first = f.controller.deviceAction("device.coldStart");
        const queued = f.controller.deviceAction("device.resume");
        await deadline(ready, 3000, "test-ready");
        const switching = f.controller.load(replacement.path);
        await expect.poll(() => f.controller.state.status).toBe("stopping");
        const stopIndex = updates.length;
        release();
        await Promise.all([first, queued, switching]);
        expect(
          command.mock.calls.filter((call) => call[0] === "cont"),
        ).toHaveLength(1); // new runtime startup only
        expect(f.controller.state.runtimeSessionId).not.toBe(oldId);
        expect(f.controller.state.profilePath).toBe(replacement.path);
        expect(
          updates
            .slice(stopIndex)
            .filter(
              (state) =>
                state.runtimeSessionId === oldId && state.status === "running",
            ),
        ).toEqual([]);
      } finally {
        cold.mockRestore();
        command.mockRestore();
        release();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "failed action and readback disable input/execution until successful refresh",
  async () => {
    const f = await fixture();
    try {
      await f.controller.load(f.profile.path);
      const real = QmpClient.prototype.command;
      let failedWrite = false;
      const fault = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(function (
          this: QmpClient,
          name,
          parameters,
          timeout,
        ) {
          if (name === "qom-set" && parameters?.property === "usb-power") {
            failedWrite = true;
            return Promise.reject(new Error("write failed"));
          }
          if (
            failedWrite &&
            name === "qom-get" &&
            parameters?.property === "battery-present"
          )
            return Promise.resolve("invalid");
          return real.call(this, name, parameters, timeout);
        });
      try {
        await expect(f.controller.deviceAction("device.usb")).rejects.toThrow();
        expect(f.controller.state.execution).toBe("unknown");
        expect(f.controller.state.devicePower).toBeUndefined();
        f.controller.key("ArrowLeft", true);
        await f.controller.flushInput();
        expect(f.controller.inputState().desiredMask).toBe(0);
        await expect(
          f.controller.deviceAction("device.resume"),
        ).rejects.toThrow();
        await expect(
          f.controller.deviceAction("device.coldStart"),
        ).rejects.toThrow();
        expect(fault.mock.calls.map((call) => call[0])).not.toContain("cont");
      } finally {
        fault.mockRestore();
      }
      await f.controller.deviceAction("device.batteryDown");
      expect(f.controller.state.execution).toBe("running");
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "device queue timeout still quits child and preserves unsaved metadata",
  async () => {
    const f = await fixture();
    try {
      await f.controller.load(f.profile.path);
      const before = await readFile(f.metadata);
      const pid = f.controller.diagnostics().qemuPid!;
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const cold = vi
        .spyOn(kernel.KernelBackend.prototype, "coldReset")
        .mockImplementation(async () => {
          entered();
          await blocked;
        });
      const command = vi.spyOn(QmpClient.prototype, "command");
      const operation = f.controller.deviceAction("device.coldStart");
      operation.catch(() => {});
      try {
        await deadline(ready, 3000, "test-ready");
        await expect(f.controller.stop()).rejects.toThrow(
          "error.saveUncertain",
        );
        expect(f.controller.state.saveUncertain).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await readFile(f.metadata)).toEqual(before);
        release();
        await operation.catch(() => {});
        expect(command.mock.calls.map((call) => call[0])).not.toContain("cont");
      } finally {
        release();
        await operation.catch(() => {});
        cold.mockRestore();
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "startup supply read cancelled by stop never continues and releases child/display/lease",
  async () => {
    const f = await fixture();
    const realRead = kernel.KernelBackend.prototype.readDeviceState;
    let release!: () => void,
      entered!: () => void,
      reads = 0;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const read = vi
      .spyOn(kernel.KernelBackend.prototype, "readDeviceState")
      .mockImplementation(async function (this: kernel.KernelBackend) {
        const state = await realRead.call(this);
        if (++reads === 1) {
          entered();
          await blocked;
        }
        return state;
      });
    const command = vi.spyOn(QmpClient.prototype, "command");
    const updates: any[] = [];
    f.controller.on("state", (state) => updates.push(state));
    const loading = f.controller.load(f.profile.path);
    loading.catch(() => {});
    try {
      await deadline(ready, 3000, "test-ready");
      const pid = f.controller.diagnostics().qemuPid!;
      const stopIndex = updates.length;
      const stopping = f.controller.stop();
      release();
      await expect(loading).rejects.toThrow("error.startCancelled");
      await stopping;
      expect(command.mock.calls.map((call) => call[0])).not.toContain("cont");
      expect(command.mock.calls.map((call) => call[0])).not.toContain(
        "input-send-event",
      );
      expect(
        updates
          .slice(stopIndex)
          .some(
            (state) => state.stage === "start" || state.status === "running",
          ),
      ).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(f.displayClosed()).toBe(true);
      expect(
        existsSync(
          join(
            f.root,
            "data",
            "kernels",
            "gwemu",
            "leases",
            f.profile.id,
            ".lease",
          ),
        ),
      ).toBe(false);
      expect(f.controller.state.status).toBe("idle");
    } finally {
      release();
      await loading.catch(() => {});
      read.mockRestore();
      command.mockRestore();
      await f.cleanup();
    }
  },
  15000,
);
