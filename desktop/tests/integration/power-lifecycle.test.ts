import { test, expect, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { SessionController } from "../../src/core/session-controller";
import { QmpClient } from "../../src/core/qmp-client";
import { createProfile } from "../../src/core/profile-store";
import { createDisplayReceiver } from "../../src/display/receiver";
import { createLogManager } from "../../src/observability/logger";

test("power adjustments are serialized and stop waits for an accepted action", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-power-order-"));
  const controller = new SessionController({
    userData: join(root, "data"),
    qemu: resolve(
      process.env.GWEMU_DESKTOP_BINARY ??
        "../build/gwemu/qemu-system-arm",
    ),
    logger: createLogManager({
      appInstanceId: "power-order",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: () => createDisplayReceiver(() => {}),
  });
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const realCommand = QmpClient.prototype.command;
  let intercept = false;
  const spy = vi
    .spyOn(QmpClient.prototype, "command")
    .mockImplementation(async function (this: QmpClient, name, args, timeout) {
      if (name === "qom-get" && args?.property === "battery" && intercept) {
        intercept = false;
        entered();
        await gate;
      }
      return realCommand.call(this, name, args, timeout);
    });
  let work: Promise<unknown> | undefined;
  try {
    const profile = await createProfile(join(root, "test.gnw.json"), {
      model: "zelda",
      internalFlash: resolve("../../firmware/internal_flash_backup_zelda.bin"),
      externalFlash: resolve("../../firmware/flash_backup_zelda.bin"),
    });
    await controller.load(profile.path);
    intercept = true;
    const first = controller.deviceAction("device.batteryDown");
    first.catch(() => {});
    await started;
    const second = controller.deviceAction("device.batteryDown");
    second.catch(() => {});
    const usb1 = controller.deviceAction("device.usb");
    const usb2 = controller.deviceAction("device.usb");
    usb1.catch(() => {});
    usb2.catch(() => {});
    let stopped = false;
    const stop = controller.stop().then(() => {
      stopped = true;
    });
    stop.catch(() => {});
    work = Promise.all([first, second, usb1, usb2, stop]);
    work.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    resume();
    await work;
    const saved = JSON.parse(
      await readFile(
        join(
          root,
          "data",
          "kernels",
          "gwemu",
          "sessions",
          profile.id,
          "session.json",
        ),
        "utf8",
      ),
    );
    expect(saved.battery).toBe(80);
    expect(saved.usbPower).toBe(false);
  } finally {
    resume();
    await work?.catch(() => {});
    await controller.stop().catch(() => {});
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
