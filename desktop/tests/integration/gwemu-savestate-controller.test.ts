import { expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
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
import { ControlRouter } from "../../src/core/control-router";
import { defaultControls } from "../../src/shared/controls";

const binary = resolve(
  process.env.GWEMU_DESKTOP_BINARY ??
    "../build/gwemu-manager-ram/qemu-system-arm",
);
async function fixture(qtest = false) {
  const root = await mkdtemp(join(tmpdir(), "gnw-state-controller-"));
  const sockets = await mkdtemp("/tmp/gnw-state-qtest-");
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
        ...(qtest ? ["-accel", "qtest"] : []),
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

function barrier() {
  let release!: () => void, enter!: () => void;
  return {
    blocked: new Promise<void>((r) => {
      release = r;
    }),
    ready: new Promise<void>((r) => {
      enter = r;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}
function routerFor(c: SessionController, turbo: number | null = null) {
  const router = new ControlRouter(
    {
      ...defaultControls(),
      bindings: [
        {
          id: "state-test",
          target: "left",
          inputs: [{ kind: "keyboard", code: "ArrowLeft" }],
          modifiers: [],
          turbo,
        },
      ],
    },
    {
      button: (bit, down, source) =>
        c.button(bit, down, source, c.state.runtimeSessionId!),
      action: () => {},
      release: () => c.releaseInput(),
      flush: () => c.flushInput(),
      physicalRelease: () => c.releasePhysicalInput(),
    },
  );
  const update = () =>
    router.setBlocked(
      !!c.state.stateOperation || !!c.state.deviceOperation,
      c.state.execution,
    );
  c.on("state", update);
  const event = (down: boolean) =>
    router.event({
      input: { kind: "keyboard", code: "ArrowLeft" },
      down,
      modifiers: [],
      source: "keyboard",
      epoch: router.epoch,
    });
  return {
    event,
    dispose: () => {
      c.off("state", update);
      router.dispose();
    },
  };
}
test.skipIf(!existsSync(binary)).each([
  [null, "support"],
  [10, "support"],
  [null, "empty"],
  [10, "empty"],
  [null, "incompatible"],
  [10, "incompatible"],
] as const)(
  "router admission and refusal quarantine held %j input through %s refusal",
  async (turbo, refusal) => {
    const f = await fixture(),
      c = f.controller,
      b = barrier();
    const toasts: any[] = [];
    c.on("toast", (value) => toasts.push(value));
    let router: ReturnType<typeof routerFor> | undefined;
    try {
      await c.load(f.profile.path);
      if (refusal === "incompatible") {
        await c.instantState("save");
        const path = join(dirname(f.metadata), "states-gwemu", "slot-0.json");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.buildSha256 = "0".repeat(64);
        await writeFile(path, JSON.stringify(manifest));
      }
      router = routerFor(c, turbo);
      router.event(true);
      await c.flushInput();
      expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(0);
      const real = QmpClient.prototype.command;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          args,
          timeout,
        ) {
          if (name === "qom-get" && args?.property === "savestate-support") {
            b.enter();
            await b.blocked;
            return refusal === "support" ? "disabled" : "";
          }
          return real.call(this, name, args, timeout);
        });
      try {
        const action = refusal === "support" ? "save" : "load";
        const operation = c.instantState(action);
        expect(c.state.stateOperation).toBe(action);
        await b.ready;
        router.event(true);
        await new Promise((r) => setTimeout(r, 80));
        expect(command.mock.calls.map((v) => v[0])).not.toContain(
          "input-send-event",
        );
        b.release();
        await operation;
        expect(toasts.at(-1).code).toBe(
          refusal === "support"
            ? "error.kernelBuild"
            : refusal === "empty"
              ? "state.empty"
              : "state.incompatible",
        );
        expect(command.mock.calls.map((v) => v[0])).not.toContain("stop");
        expect(command.mock.calls.map((v) => v[0])).not.toContain("qom-set");
        router.event(true);
        await c.flushInput();
        expect(c.inputState().desiredMask).toBe(0);
        router.event(false);
        await c.flushInput();
        expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(2048);
        router.event(true);
        await c.flushInput();
        expect(c.inputState().desiredMask).toBe(1);
        expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(0);
      } finally {
        b.release();
        command.mockRestore();
      }
    } finally {
      router?.dispose();
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "paused load and router unblock preserve automatic POWER pulse and its remaining release",
  async () => {
    const f = await fixture(true),
      c = f.controller;
    let router: ReturnType<typeof routerFor> | undefined;
    try {
      await c.load(f.profile.path);
      router = routerFor(c);
      await c.deviceAction("device.coldStart");
      await f.hardware(["clock_step 800000000"]);
      expect((await f.hardware(["readl 0x58020010"]))[0] & 1).toBe(0);
      await c.deviceAction("device.pause");
      await c.instantState("save");
      await f.hardware(["clock_step 500000000"]);
      const command = vi.spyOn(QmpClient.prototype, "command");
      try {
        await c.instantState("load");
        c.releaseInput();
        c.releaseChassis(c.state.runtimeSessionId!);
        await c.flushInput();
        expect((await f.hardware(["readl 0x58020010"]))[0] & 1).toBe(0);
        expect(command.mock.calls.map((v) => v[0])).not.toContain(
          "input-send-event",
        );
        await c.deviceAction("device.resume");
        await f.hardware(["clock_step 149000000"]);
        expect((await f.hardware(["readl 0x58020010"]))[0] & 1).toBe(0);
        await f.hardware(["clock_step 1000000"]);
        expect((await f.hardware(["readl 0x58020010"]))[0] & 1).toBe(1);
      } finally {
        command.mockRestore();
      }
    } finally {
      router?.dispose();
      await f.cleanup();
    }
  },
  20000,
);

test.skipIf(!existsSync(binary))(
  "unknown restored readback forces paused execution and persistent shutdown uncertainty",
  async () => {
    const f = await fixture(),
      c = f.controller;
    try {
      await c.load(f.profile.path);
      await c.instantState("save");
      const before = await readFile(f.metadata),
        real = QmpClient.prototype.command;
      let continued = false;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(function (this: QmpClient, name, args, timeout) {
          if (name === "cont") continued = true;
          if (
            continued &&
            name === "qom-get" &&
            args?.property === "battery-present"
          )
            return Promise.resolve("invalid");
          return real.call(this, name, args, timeout);
        });
      try {
        await c.instantState("load");
        expect(c.state.execution).toBe("unknown");
        expect(
          (await real.call((c as any).runtime.qmp, "query-status")).running,
        ).toBe(false);
        await expect(c.stop()).rejects.toThrow("error.saveUncertain");
        expect(await readFile(f.metadata)).toEqual(before);
      } finally {
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);
test.skipIf(!existsSync(binary))(
  "native gwemu slots restore full Flash/RAM, paused and off points without paused input",
  async () => {
    const f = await fixture(),
      c = f.controller;
    const toasts: any[] = [];
    c.on("toast", (v) => toasts.push(v));
    try {
      await c.load(f.profile.path);
      expect(c.state.canInstantState).toBe(true);
      await f.hardware([
        "writel 0x20000100 0x12345678",
        "writel 0x08000100 0xabcdef12",
      ]);
      await c.instantState("save");
      expect(toasts.at(-1).code).toBe("state.saved");
      expect(c.state.stateSlots?.[0]).not.toBeNull();
      const d = dirname(f.metadata);
      expect(existsSync(join(d, "states"))).toBe(false);
      const manifest = JSON.parse(
        await readFile(join(d, "states-gwemu/slot-0.json"), "utf8"),
      );
      expect(manifest).toMatchObject({ version: 2, kernel: "gwemu" });
      expect(manifest.buildSha256).toMatch(/^[a-f0-9]{64}$/);
      await c.deviceAction("device.pause");
      c.selectStateSlot(2);
      await c.instantState("save");
      await f.hardware(["writel 0x20000100 0", "writel 0x08000100 0"]);
      const command = vi.spyOn(QmpClient.prototype, "command");
      try {
        await c.instantState("load");
        c.releaseInput();
        c.releaseChassis(c.state.runtimeSessionId!);
        await c.flushInput();
        expect(toasts.at(-1).code).toBe("state.loaded");
        expect(c.state.execution).toBe("paused");
        expect(command.mock.calls.map((v) => v[0])).not.toContain(
          "input-send-event",
        );
        expect(command.mock.calls.map((v) => v[0])).not.toContain("cont");
        expect(
          await f.hardware(["readl 0x20000100", "readl 0x08000100"]),
        ).toEqual([0x12345678, 0xabcdef12]);
      } finally {
        command.mockRestore();
      }
      await c.deviceAction("device.batteryPresent");
      expect(c.state.execution).toBe("unpowered");
      c.selectStateSlot(1);
      await c.instantState("save");
      await c.deviceAction("device.batteryPresent");
      await c.deviceAction("device.resume");
      await c.instantState("load");
      expect(c.state.execution).toBe("unpowered");
      c.selectStateSlot(0);
      await c.instantState("load");
      expect(c.state.execution).toBe("paused");
      await c.deviceAction("device.resume");
      await c.instantState("load");
      expect(c.state.execution).toBe("running");
      await c.stop();
      await c.load(f.profile.path);
      expect(c.state.stateSlots?.[0]).toBe(manifest.savedAt);
      await c.instantState("load");
      expect(toasts.at(-1).code).toBe("state.loaded");
    } finally {
      await f.cleanup();
    }
  },
  30000,
);

test.skipIf(!existsSync(binary))(
  "accepted snapshot blocks device mutations and queued replacement is cancelled by stop",
  async () => {
    const f = await fixture(),
      c = f.controller,
      b = barrier();
    try {
      await c.load(f.profile.path);
      const replacement = await createProfile(
        join(f.root, "replacement.gnw.json"),
        {
          model: "mario",
          internalFlash: f.profile.internalFlash,
          externalFlash: f.profile.externalFlash,
        },
      );
      const real = QmpClient.prototype.command;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          args,
          timeout,
        ) {
          if (name === "qom-set" && args?.property === "save-state") {
            b.enter();
            await b.blocked;
          }
          return real.call(this, name, args, timeout);
        });
      try {
        const save = c.instantState("save");
        await deadline(b.ready, 3000, "snapshot");
        const oldId = c.state.runtimeSessionId;
        await c.deviceAction("device.usb");
        expect(
          command.mock.calls.filter(
            (v) => v[0] === "qom-set" && v[1]?.property === "usb-power",
          ),
        ).toHaveLength(0);
        const loading = c.load(replacement.path);
        loading.catch(() => {});
        await expect(c.load(replacement.path)).rejects.toThrow("busy");
        const stopping = c.stop();
        const index = command.mock.calls.length;
        b.release();
        await save;
        await expect(loading).rejects.toThrow("error.startCancelled");
        await stopping;
        expect(c.state.status).toBe("idle");
        expect(c.state.runtimeSessionId).not.toBe(oldId);
        expect(command.mock.calls.slice(index).map((v) => v[0])).not.toContain(
          "cont",
        );
        expect(
          existsSync(
            join(f.root, "data/kernels/gwemu/sessions", replacement.id),
          ),
        ).toBe(false);
      } finally {
        b.release();
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  20000,
);

test.skipIf(!existsSync(binary))(
  "failed target and recovery persist uncertainty, retain recovery and close without metadata success",
  async () => {
    const f = await fixture(),
      c = f.controller;
    try {
      await c.load(f.profile.path);
      await c.instantState("save");
      const before = await readFile(f.metadata),
        pid = c.diagnostics().qemuPid!;
      const real = QmpClient.prototype.command;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(function (this: QmpClient, name, args, timeout) {
          if (name === "qom-set" && args?.property === "load-state")
            return Promise.reject(Error("forced restore failure"));
          return real.call(this, name, args, timeout);
        });
      try {
        await c.instantState("load");
        expect(c.state.execution).toBe("unknown");
        expect(c.state.saveUncertain).toBe(true);
        const index = command.mock.calls.length;
        await c.deviceAction("device.resume");
        await c.deviceAction("device.coldStart");
        await c.deviceAction("device.usb");
        expect(
          command.mock.calls
            .slice(index)
            .filter(
              (v) =>
                v[0] === "cont" ||
                v[0] === "system_reset" ||
                v[0] === "qom-set",
            ),
        ).toHaveLength(0);
        await expect(c.stop()).rejects.toThrow("error.saveUncertain");
        expect(c.state.saveUncertain).toBe(true);
        expect(f.displayClosed()).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await readFile(f.metadata)).toEqual(before);
        expect(
          (await readdir(join(dirname(f.metadata), "states-gwemu"))).some((v) =>
            v.startsWith("rollback-"),
          ),
        ).toBe(true);
      } finally {
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  20000,
);

test
  .skipIf(!existsSync(binary))
  .each([null, false, 0, {}, "disabled", "timing", "unknown"])(
  "strict runtime support %j refuses snapshot without stopping or writing guest",
  async (support) => {
    const f = await fixture(),
      c = f.controller,
      toasts: any[] = [];
    c.on("toast", (v) => toasts.push(v));
    try {
      await c.load(f.profile.path);
      const real = QmpClient.prototype.command;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(function (this: QmpClient, name, args, timeout) {
          if (name === "qom-get" && args?.property === "savestate-support")
            return Promise.resolve(support);
          return real.call(this, name, args, timeout);
        });
      try {
        await c.instantState("save");
        expect(toasts.at(-1).code).toBe("error.kernelBuild");
        expect(command.mock.calls.map((v) => v[0])).not.toContain("stop");
        expect(command.mock.calls.map((v) => v[0])).not.toContain("qom-set");
      } finally {
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "stop cancels replacement during preflight while closing the old process",
  async () => {
    const f = await fixture(),
      c = f.controller,
      b = barrier();
    try {
      await c.load(f.profile.path);
      const pid = c.diagnostics().qemuPid!;
      const replacement = await createProfile(
        join(f.root, "preflight.gnw.json"),
        {
          model: "mario",
          internalFlash: f.profile.internalFlash,
          externalFlash: f.profile.externalFlash,
        },
      );
      const real = kernel.preflightKernel;
      const preflight = vi
        .spyOn(kernel, "preflightKernel")
        .mockImplementation(async (...args) => {
          b.enter();
          await b.blocked;
          return real(...args);
        });
      try {
        const loading = c.load(replacement.path);
        loading.catch(() => {});
        await b.ready;
        const stopping = c.stop();
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
        b.release();
        await expect(loading).rejects.toThrow("error.startCancelled");
        await stopping;
        expect(c.state.status).toBe("idle");
        expect(
          existsSync(
            join(f.root, "data/kernels/gwemu/sessions", replacement.id),
          ),
        ).toBe(false);
      } finally {
        b.release();
        preflight.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "malformed target recovers the pre-load point and its running state",
  async () => {
    const f = await fixture(),
      c = f.controller,
      toasts: any[] = [];
    c.on("toast", (v) => toasts.push(v));
    try {
      await c.load(f.profile.path);
      await c.instantState("save");
      const directory = join(dirname(f.metadata), "states-gwemu");
      const slot = JSON.parse(
        await readFile(join(directory, "slot-0.json"), "utf8"),
      );
      await writeFile(
        join(directory, slot.id, "state.bin"),
        "corrupt-native-state",
      );
      await f.hardware([
        "writel 0x20000100 0x11223344",
        "writel 0x08000100 0x33445566",
      ]);
      await c.instantState("load");
      expect(toasts.at(-1).code).toBe("state.failed");
      expect(c.state.execution).toBe("running");
      expect(c.state.saveUncertain).not.toBe(true);
      expect(
        await f.hardware(["readl 0x20000100", "readl 0x08000100"]),
      ).toEqual([0x11223344, 0x33445566]);
      expect(
        (await readdir(directory)).some((v) => v.startsWith("rollback-")),
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "stop during failing recovery has no late cont and still cleans its child",
  async () => {
    const f = await fixture(),
      c = f.controller,
      b = barrier();
    try {
      await c.load(f.profile.path);
      await c.instantState("save");
      const pid = c.diagnostics().qemuPid!,
        before = await readFile(f.metadata);
      const real = QmpClient.prototype.command;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          args,
          timeout,
        ) {
          if (name === "qom-set" && args?.property === "load-state") {
            b.enter();
            await b.blocked;
            throw Error("forced load failure");
          }
          return real.call(this, name, args, timeout);
        });
      try {
        const loading = c.instantState("load");
        await b.ready;
        const stopping = c.stop();
        stopping.catch(() => {});
        const index = command.mock.calls.length;
        b.release();
        await loading;
        await expect(stopping).rejects.toThrow("error.saveUncertain");
        expect(command.mock.calls.slice(index).map((v) => v[0])).not.toContain(
          "cont",
        );
        expect(() => process.kill(pid, 0)).toThrow();
        expect(f.displayClosed()).toBe(true);
        expect(await readFile(f.metadata)).toEqual(before);
      } finally {
        b.release();
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary))(
  "snapshot admission drains actual in-flight turbo input and retires queued phases before stop/load",
  async () => {
    const f = await fixture(),
      c = f.controller,
      b = barrier();
    let router: ReturnType<typeof routerFor> | undefined;
    try {
      await c.load(f.profile.path);
      router = routerFor(c, 10);
      const real = QmpClient.prototype.command;
      let held = false;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          args,
          timeout,
        ) {
          const value = await real.call(this, name, args, timeout);
          if (name === "input-send-event" && !held) {
            held = true;
            b.enter();
            await b.blocked;
          }
          return value;
        });
      try {
        router.event(true);
        await b.ready;
        expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 75));
        c.button(1, true, "unsent", c.state.runtimeSessionId!);
        const saving = c.instantState("save");
        expect(c.inputState().desiredMask).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(command.mock.calls.map((v) => v[0])).not.toContain("stop");
        b.release();
        await saving;
        const stops = command.mock.calls.findIndex((v) => v[0] === "stop");
        const sends = command.mock.calls
          .map((v, index) => ({ v, index }))
          .filter(({ v }) => v[0] === "input-send-event");
        expect(sends).toHaveLength(2);
        expect(sends[1].index).toBeLessThan(stops);
        expect(sends[1].v[1]?.events).toMatchObject([
          { type: "key", data: { down: false, key: { data: "left" } } },
        ]);
        expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(2048);
        await c.deviceAction("device.pause");
        const index = command.mock.calls.length;
        await c.instantState("load");
        router.event(false);
        await c.flushInput();
        expect(command.mock.calls.slice(index).map((v) => v[0])).not.toContain(
          "input-send-event",
        );
        expect(c.inputState().appliedMask).toBe(0);
        expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(2048);
      } finally {
        b.release();
        command.mockRestore();
      }
    } finally {
      router?.dispose();
      await f.cleanup();
    }
  },
  15000,
);

test.skipIf(!existsSync(binary)).each([false, true])(
  "snapshot-queued replacement invalid=%s preserves owner and admits at most one new runtime",
  async (invalid) => {
    const f = await fixture(),
      c = f.controller,
      state = barrier(),
      preflight = barrier();
    try {
      await c.load(f.profile.path);
      const oldId = c.state.runtimeSessionId,
        oldPid = c.diagnostics().qemuPid;
      const replacement = await createProfile(join(f.root, "queued.gnw.json"), {
        model: "mario",
        internalFlash: f.profile.internalFlash,
        externalFlash: f.profile.externalFlash,
      });
      const real = QmpClient.prototype.command,
        realPreflight = kernel.preflightKernel;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          args,
          timeout,
        ) {
          if (name === "qom-set" && args?.property === "save-state") {
            state.enter();
            await state.blocked;
          }
          return real.call(this, name, args, timeout);
        });
      const probe = vi
        .spyOn(kernel, "preflightKernel")
        .mockImplementation(async (...args) => {
          preflight.enter();
          await preflight.blocked;
          if (invalid) throw Error("invalid replacement preflight");
          return realPreflight(...args);
        });
      const display = vi.spyOn((c as any).options, "createDisplay");
      try {
        const saving = c.instantState("save");
        await state.ready;
        const loading = c.load(replacement.path);
        loading.catch(() => {});
        state.release();
        await saving;
        await preflight.ready;
        expect(c.state.deviceOperation).toBe(true);
        expect(c.state.stateOperation).toBeUndefined();
        const index = command.mock.calls.length;
        c.key("ArrowLeft", true);
        await c.flushInput();
        await c.deviceAction("device.usb");
        expect(
          command.mock.calls
            .slice(index)
            .filter((v) => v[0] === "input-send-event" || v[0] === "qom-set"),
        ).toHaveLength(0);
        expect(display).not.toHaveBeenCalled();
        preflight.release();
        if (invalid) {
          await expect(loading).rejects.toThrow(
            "invalid replacement preflight",
          );
          expect(c.state.runtimeSessionId).toBe(oldId);
          expect(c.diagnostics().qemuPid).toBe(oldPid);
          expect(c.state.deviceOperation).toBe(false);
          expect(display).not.toHaveBeenCalled();
          expect(
            existsSync(
              join(f.root, "data/kernels/gwemu/sessions", replacement.id),
            ),
          ).toBe(false);
        } else {
          await loading;
          expect(display).toHaveBeenCalledTimes(1);
          expect(c.state.runtimeSessionId).not.toBe(oldId);
          expect(c.diagnostics().qemuPid).not.toBe(oldPid);
          expect(c.state.execution).toBe("running");
          const directory = join(
            f.root,
            "data/kernels/gwemu/sessions",
            replacement.id,
          );
          expect(await readdir(join(directory, "runs"))).toHaveLength(1);
          expect(() => process.kill(oldPid!, 0)).toThrow();
        }
      } finally {
        state.release();
        preflight.release();
        probe.mockRestore();
        command.mockRestore();
        display.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  20000,
);

test.skipIf(!existsSync(binary))(
  "actual QMP disconnect during restore owns shutdown and retains failed recovery",
  async () => {
    const f = await fixture(),
      c = f.controller,
      b = barrier();
    try {
      await c.load(f.profile.path);
      await c.instantState("save");
      const pid = c.diagnostics().qemuPid!,
        before = await readFile(f.metadata);
      const qmp = (c as any).runtime.qmp as QmpClient,
        real = QmpClient.prototype.command;
      const command = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          args,
          timeout,
        ) {
          if (
            this === qmp &&
            name === "qom-set" &&
            args?.property === "load-state"
          ) {
            b.enter();
            await b.blocked;
          }
          return real.call(this, name, args, timeout);
        });
      try {
        const loading = c.instantState("load");
        await b.ready;
        const index = command.mock.calls.length;
        const disconnected = new Promise<void>((resolve) =>
          qmp.once("disconnect", resolve),
        );
        (qmp as any).socket.destroy();
        await disconnected;
        b.release();
        await loading;
        await expect
          .poll(() => c.diagnostics().qemuPid, { timeout: 10000 })
          .toBeUndefined();
        expect(c.state.saveUncertain).toBe(true);
        expect(c.state.status).toBe("error");
        expect(command.mock.calls.slice(index).map((v) => v[0])).not.toContain(
          "cont",
        );
        expect(command.mock.calls.slice(index).map((v) => v[0])).not.toContain(
          "system_reset",
        );
        expect(() => process.kill(pid, 0)).toThrow();
        expect(f.displayClosed()).toBe(true);
        expect(await readFile(f.metadata)).toEqual(before);
        expect(
          (await readdir(join(dirname(f.metadata), "states-gwemu"))).some((v) =>
            v.startsWith("rollback-"),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(f.root, "data/kernels/gwemu/leases", f.profile.id, ".lease"),
          ),
        ).toBe(false);
      } finally {
        b.release();
        command.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  },
  25000,
);

test.skipIf(!existsSync(binary))(
  "paused and off real routed USB/save/load hotkeys work without guest input",
  async () => {
    const f = await fixture(),
      c = f.controller,
      jobs: Promise<void>[] = [];
    let router: ControlRouter | undefined, update: (() => void) | undefined;
    try {
      await c.load(f.profile.path);
      await c.deviceAction("device.pause");
      router = new ControlRouter(
        {
          ...defaultControls(),
          bindings: [
            ...defaultControls().bindings,
            {
              id: "paused-turbo",
              target: "a",
              inputs: [{ kind: "keyboard", code: "KeyJ" }],
              modifiers: [],
              turbo: 10,
            },
          ],
        },
        {
          button: (bit, down, source) =>
            c.button(bit, down, source, c.state.runtimeSessionId!),
          action: (id) => {
            if (id === "device.usb") jobs.push(c.deviceAction(id));
            else if (id === "state.save" || id === "state.load")
              jobs.push(c.instantState(id === "state.save" ? "save" : "load"));
          },
          release: () => c.releaseInput(),
          physicalRelease: () => c.releasePhysicalInput(),
          flush: () => c.flushInput(),
        },
      );
      update = () =>
        router!.setBlocked(
          !!c.state.stateOperation || !!c.state.deviceOperation,
          c.state.execution,
        );
      c.on("state", update);
      update();
      const event = (code: string, down: boolean) =>
        router!.event({
          source: "keyboard",
          input: { kind: "keyboard", code },
          down,
          modifiers: [],
          epoch: router!.epoch,
        });
      const hotkey = async (code: string) => {
        const previous = jobs.length;
        event(code, true);
        event(code, false);
        expect(jobs).toHaveLength(previous + 1);
        await jobs.at(-1);
      };
      const command = vi.spyOn(QmpClient.prototype, "command");
      try {
        event("ArrowLeft", true);
        event("KeyJ", true);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await c.flushInput();
        await hotkey("F5");
        expect(c.state.execution).toBe("paused");
        await hotkey("F8");
        expect(c.state.execution).toBe("paused");
        await c.deviceAction("device.batteryPresent");
        expect(c.state.execution).toBe("unpowered");
        c.selectStateSlot(1);
        await hotkey("F5");
        expect(c.state.execution).toBe("unpowered");
        await hotkey("KeyC");
        expect(c.state.execution).toBe("paused");
        expect(c.state.devicePower?.usbPower).toBe(true);
        await hotkey("F8");
        expect(c.state.execution).toBe("unpowered");
        expect(c.state.devicePower?.usbPower).toBe(false);
        expect(command.mock.calls.map((v) => v[0])).not.toContain(
          "input-send-event",
        );
        expect((await f.hardware(["readl 0x58020c10"]))[0] & 2048).toBe(2048);
        expect(c.inputState().appliedMask).toBe(0);
      } finally {
        command.mockRestore();
      }
    } finally {
      if (update) c.off("state", update);
      router?.dispose();
      await f.cleanup();
    }
  },
  20000,
);
