import { test, expect, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionController } from "../../src/core/session-controller";
import { createDisplayReceiver } from "../../src/display/receiver";
import { createProfile } from "../../src/core/profile-store";
import { createLogManager } from "../../src/observability/logger";
import {
  KernelBackend,
  captureKernelIdentity,
} from "../../src/core/kernel-backend";
import { Writable } from "node:stream";
test("real QEMU lifecycle preserves running session on invalid ROM then saves on exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-lifecycle-"));
  const firmware = resolve(process.env.GNW_TEST_FIRMWARE ?? "../../firmware");
  const profile = await createProfile(join(root, "game.gnw.json"), {
    model: "zelda",
    internalFlash: join(firmware, "internal_flash_backup_zelda.bin"),
    externalFlash: join(firmware, "flash_backup_zelda.bin"),
  });
  const logs = createLogManager({
    appInstanceId: "test",
    destination: new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
  });
  const controller = new SessionController({
    userData: join(root, "UserData"),
    qemu: resolve(
      process.env.GWEMU_DESKTOP_BINARY ??
        (process.platform === "win32" ? "../build/gwemu/qemu-system-arm.exe" : "../build/gwemu/qemu-system-arm"),
    ),
    logger: logs.child("session"),
    createDisplay: () => createDisplayReceiver(() => {}),
  });
  try {
    await controller.load(profile.path);
    expect(controller.state.status).toBe("running");
    const runtime = controller.state.runtimeSessionId;
    await expect(
      controller.load(join(root, "missing.gnw.json")),
    ).rejects.toThrow();
    expect(controller.state.runtimeSessionId).toBe(runtime);
    expect(controller.state.status).toBe("running");
    controller.key("ArrowLeft", true);
    controller.key("ArrowLeft", false);
    const capture = await controller.probe(join(root, "screen.png"));
    expect(capture.registers).toContain("R00");
    await controller.stop();
    expect(controller.state.status).toBe("idle");
    const saved = JSON.parse(
      await readFile(
        join(
          root,
          "UserData",
          "kernels",
          "gwemu",
          "sessions",
          profile.id,
          "session.json",
        ),
        "utf8",
      ),
    );
    expect(saved.battery).toBeGreaterThanOrEqual(0);
  } finally {
    await controller.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("startup endpoint failure releases lease and missing power snapshot is never reported saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-faults-"));
  const firmware = resolve(process.env.GNW_TEST_FIRMWARE ?? "../../firmware");
  const userData = join(root, "UserData");
  const profile = await createProfile(join(root, "game.gnw.json"), {
    model: "zelda",
    internalFlash: join(firmware, "internal_flash_backup_zelda.bin"),
    externalFlash: join(firmware, "flash_backup_zelda.bin"),
  });
  const logger = createLogManager({
    appInstanceId: "faults",
    destination: new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
  }).child("session");
  const failed = new SessionController({
    userData,
    qemu: resolve(
      process.env.GWEMU_DESKTOP_BINARY ??
        (process.platform === "win32" ? "../build/gwemu/qemu-system-arm.exe" : "../build/gwemu/qemu-system-arm"),
    ),
    logger,
    createDisplay: async () => {
      throw new Error("endpoint unavailable");
    },
  });
  const working = new SessionController({
    userData,
    qemu: resolve(
      process.env.GWEMU_DESKTOP_BINARY ??
        (process.platform === "win32" ? "../build/gwemu/qemu-system-arm.exe" : "../build/gwemu/qemu-system-arm"),
    ),
    logger,
    createDisplay: () => createDisplayReceiver(() => {}),
  });
  try {
    await expect(failed.load(profile.path)).rejects.toThrow(
      "endpoint unavailable",
    );
    expect(failed.state.status).toBe("error");
    const startup = working.load(profile.path);
    await expect(working.load(profile.path)).rejects.toThrow("busy");
    await startup;
    vi.spyOn(KernelBackend.prototype, "snapshotPower").mockRejectedValueOnce(
      new Error("power snapshot unavailable"),
    );
    await expect(working.stop()).rejects.toThrow();
    expect(working.state.saveUncertain).toBe(true);
    expect(working.state.status).toBe("error");
  } finally {
    vi.restoreAllMocks();
    await working.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("state slots survive restart, corrupt loads roll back and stop waits for save", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-controller-states-"));
  const firmware = resolve(process.env.GNW_TEST_FIRMWARE ?? "../../firmware");
  const profile = await createProfile(join(root, "game.gnw.json"), {
    model: "zelda",
    internalFlash: join(firmware, "internal_flash_backup_zelda.bin"),
    externalFlash: join(firmware, "flash_backup_zelda.bin"),
  });
  const controller = new SessionController({
    userData: join(root, "data"),
    qemu: resolve(
      process.env.GWEMU_DESKTOP_BINARY ??
        (process.platform === "win32" ? "../build/gwemu/qemu-system-arm.exe" : "../build/gwemu/qemu-system-arm"),
    ),
    logger: createLogManager({
      appInstanceId: "states",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: () => createDisplayReceiver(() => {}),
  });
  const messages: any[] = [];
  controller.on("toast", (message) => messages.push(message));
  try {
    await controller.load(profile.path);
    await controller.instantState("save");
    expect(messages.at(-1).code).toBe("state.saved");
    const directory = join(
      root,
      "data",
      "kernels",
      "gwemu",
      "sessions",
      profile.id,
    );
    const { loadSlot } = await import("../../src/core/savestate-store");
    const identity = await captureKernelIdentity(
      "gwemu",
      resolve(
        process.env.GWEMU_DESKTOP_BINARY ??
          (process.platform === "win32" ? "../build/gwemu/qemu-system-arm.exe" : "../build/gwemu/qemu-system-arm"),
      ),
    );
    const path = await loadSlot(directory, 0, identity);
    expect((await readFile(path)).length).toBeGreaterThan(4 * 1024 * 1024);
    controller.selectStateSlot(1);
    await controller.instantState("load");
    expect(messages.at(-1).code).toBe("state.empty");
    controller.selectStateSlot(0);
    await controller.instantState("load");
    expect(messages.at(-1).code).toBe("state.loaded");
    await controller.stop();
    await controller.load(profile.path);
    await controller.instantState("load");
    expect(messages.at(-1).code).toBe("state.loaded");
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(path);
    await writeFile(path, original.subarray(0, original.length / 2));
    await controller.instantState("load");
    expect(messages.at(-1).kind).toBe("error");
    expect(controller.state.status).toBe("running");
    const capture = await controller.probe(join(root, "after.png"));
    expect(capture.registers).toContain("R00");
    controller.selectStateSlot(2);
    const saving = controller.instantState("save");
    await controller.stop();
    await saving;
    expect(controller.state.status).toBe("idle");
    expect(await loadSlot(directory, 2, identity)).toBeTruthy();
  } finally {
    await controller.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
