import { expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import * as kernel from "../../src/core/kernel-backend";
import { createProfile } from "../../src/core/profile-store";
import { SessionController } from "../../src/core/session-controller";
import { QmpClient } from "../../src/core/qmp-client";
import { createDisplayReceiver } from "../../src/display/receiver";
import { createLogManager } from "../../src/observability/logger";

const binary = resolve(
  process.env.GWEMU_DESKTOP_BINARY ?? "../build/gwemu-supply/qemu-system-arm",
);
test.skipIf(!existsSync(binary))(
  "gwemu controller isolates data, preserves active ROM on unsupported input and stops cleanly",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gnw-preview-controller-"));
    const sockets = await mkdtemp("/tmp/gnw-preview-test-");
    const realArguments = kernel.kernelArguments;
    let qtestPath = "",
      generation = 0;
    // QTest is injected only by the integration test, never by the product.
    const args = vi
      .spyOn(kernel, "kernelArguments")
      .mockImplementation(async (...options) => {
        qtestPath = join(sockets, `${++generation}.sock`);
        return [
          ...(await realArguments(...options)),
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
        const results = [];
        for (const command of commands) {
          socket.write(command + "\n");
          const reply = (await lines.next()).value;
          expect(reply).toMatch(/^OK/);
          results.push(reply!.slice(2).trim());
        }
        return results;
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
      deviceUid: "310047000b51333138343134",
    });
    const controller = new SessionController({
      kernel: "gwemu",
      qemu: binary,
      userData: join(root, "data"),
      logger: createLogManager({
        appInstanceId: "gwemu",
        destination: new Writable({
          write(_c, _e, done) {
            done();
          },
        }),
      }).child("session"),
      createDisplay: () => createDisplayReceiver(() => {}),
    });
    const toasts: any[] = [];
    controller.on("toast", (value) => toasts.push(value));
    try {
      await controller.load(profile.path);
      expect(controller.state.status).toBe("running");
      expect(controller.state.canInstantState).toBe(false);
      const id = controller.state.runtimeSessionId;
      expect(existsSync(join(root, "data", "sessions", profile.id))).toBe(
        false,
      );
      const directory = join(
        root,
        "data",
        "kernels",
        "gwemu",
        "sessions",
        profile.id,
      );
      expect(existsSync(join(directory, "flash.bin"))).toBe(true);
      controller.key("ArrowLeft", true);
      await controller.flushInput();
      expect(controller.inputState().appliedMask).toBe(1);
      expect(
        Number((await hardware(["readl 0x58020c10"]))[0]) & (1 << 11),
      ).toBe(0);
      controller.releaseInput();
      await controller.flushInput();
      expect(controller.inputState().appliedMask).toBe(0);
      expect(
        Number((await hardware(["readl 0x58020c10"]))[0]) & (1 << 11),
      ).toBe(1 << 11);
      await hardware(["writel 0x08000100 0x12345678", "readl 0x08000100"]);
      await controller.setMuted(true);
      expect(controller.diagnostics().audioMuted).toBe(true);
      await controller.setMuted(false);
      expect(controller.diagnostics().audioMuted).toBe(false);
      await controller.instantState("save");
      expect(toasts.at(-1).code).toBe("state.unsupportedKernel");
      expect(existsSync(join(directory, "states"))).toBe(false);
      await Promise.all([
        controller.deviceAction("device.batteryDown"),
        controller.deviceAction("device.batteryDown"),
        controller.deviceAction("device.usb"),
        controller.deviceAction("device.usb"),
      ]);
      await controller.deviceAction("device.usb");
      const readings = await hardware([
        "writel 0x40022030 0x100", // ADC1 channel4
        "writel 0x40022008 0x1",
        "writel 0x40022008 0x5",
        "readl 0x40022040",
        "readl 0x58020010", // PA2 PGOOD
        "readl 0x58021010", // PE7 CHG
      ]);
      // The real virtual clock can drain a fractional level before USB toggles.
      expect(Math.abs(Number(readings[3]) - 12600)).toBeLessThanOrEqual(1);
      expect(Number(readings[4]) & 4).toBe(0);
      expect(Number(readings[5]) & 128).toBe(0);
      await writeFile(
        join(root, "unsupported.bin"),
        Buffer.alloc(2 * 1024 * 1024),
      );
      const unsupported = await createProfile(join(root, "bad.gnw.json"), {
        model: "mario",
        internalFlash: profile.internalFlash,
        externalFlash: join(root, "unsupported.bin"),
      });
      await expect(controller.load(unsupported.path)).rejects.toThrow(
        /capacity/,
      );
      const card = await open(join(root, "sd.img"), "w");
      await card.truncate(32 * 1024 * 1024);
      await card.close();
      const ospi = await createProfile(join(root, "ospi.gnw.json"), {
        model: "mario",
        internalFlash: profile.internalFlash,
        externalFlash: profile.externalFlash,
        sdCard: join(root, "sd.img"),
        sdWiring: "ospi",
      });
      const oldBinary = resolve("../build/gwemu-power/qemu-system-arm");
      if (existsSync(oldBinary)) {
        const preflight = kernel.preflightKernel;
        const old = vi
          .spyOn(kernel, "preflightKernel")
          .mockImplementation((kind, target) =>
            preflight(kind, target, oldBinary),
          );
        try {
          await expect(controller.load(ospi.path)).rejects.toThrow(
            "error.kernelBuild",
          );
        } finally {
          old.mockRestore();
        }
      }
      expect(controller.state.runtimeSessionId).toBe(id);
      expect(controller.state.status).toBe("running");
      await controller.stop();
      expect(controller.state.status).toBe("idle");
      expect(
        JSON.parse(await readFile(join(directory, "session.json"), "utf8"))
          .battery,
      ).toBe(80);
      await controller.load(profile.path);
      expect(controller.state.runtimeSessionId).not.toBe(id);
      expect(Number((await hardware(["readl 0x08000100"]))[0])).toBe(
        0x12345678,
      );
      expect(Number((await hardware(["readl 0x58020010"]))[0]) & 4).toBe(0);
      // A failed power readback must still stop the child and preserve metadata.
      const saved = await readFile(join(directory, "session.json"));
      const pid = controller.diagnostics().qemuPid!;
      const realCommand = QmpClient.prototype.command;
      const fault = vi
        .spyOn(QmpClient.prototype, "command")
        .mockImplementation(async function (
          this: QmpClient,
          name,
          parameters,
          timeout,
        ) {
          if (name === "qom-get" && parameters?.property === "battery")
            throw new Error("power readback disconnected");
          return realCommand.call(this, name, parameters, timeout);
        });
      try {
        await expect(controller.stop()).rejects.toThrow("error.saveUncertain");
        expect(controller.state.saveUncertain).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await readFile(join(directory, "session.json"))).toEqual(saved);
      } finally {
        fault.mockRestore();
      }
      await controller.load(profile.path);
      // Crash must never claim that session state was saved successfully.
      process.kill(controller.diagnostics().qemuPid!, "SIGKILL");
      await expect.poll(() => controller.state.status).toBe("error");
      expect(controller.state.saveUncertain).toBe(true);
      await controller.load(profile.path);
      await controller.stop();
      // Use the actual controller-created session image for protocol writes.
      for (const wiring of ["spi1", "ospi"] as const) {
        const target =
          wiring === "ospi"
            ? ospi
            : await createProfile(join(root, "spi1.gnw.json"), {
                model: "mario",
                internalFlash: profile.internalFlash,
                externalFlash: profile.externalFlash,
                sdCard: join(root, "sd.img"),
                sdWiring: wiring,
              });
        const setup = async () => {
          if (wiring === "ospi")
            await hardware([
              "writel 0x58020400 0x14", // PB1/PB2 output
              "writel 0x58020c00 0x0", // PD12 input
              "writel 0x58021000 0x400000", // PE11 output
              "writel 0x58021018 0x800", // PE11 high selects SD
            ]);
        };
        const exchange = async (byte: number) => {
          if (wiring === "spi1") {
            const values = await hardware([
              `writeb 0x40013020 ${byte}`,
              "readb 0x40013030",
            ]);
            return Number(values[1]);
          }
          const commands: string[] = ["writel 0x58021018 0x800"];
          for (let bit = 7; bit >= 0; bit--) {
            const mosi = ((byte >> bit) & 1) << 1;
            commands.push(
              `writel 0x58020414 ${mosi}`,
              `writel 0x58020414 ${mosi | 4}`,
              "readl 0x58020c10",
              `writel 0x58020414 ${mosi}`,
            );
          }
          commands.push("writel 0x58021018 0x8000000");
          const values = await hardware(commands);
          let result = 0;
          for (let bit = 0; bit < 8; bit++)
            result = (result << 1) | ((Number(values[3 + bit * 4]) >> 12) & 1);
          return result;
        };
        const response = async () => {
          for (let attempt = 0; attempt < 12; attempt++) {
            const result = await exchange(255);
            if (result !== 255) return result;
          }
          throw new Error("SD response timed out");
        };
        const command = async (index: number, argument = 0) => {
          // Consume response tail before issuing another command.
          await exchange(255);
          await exchange(255);
          for (const byte of [
            0x40 | index,
            argument >>> 24,
            (argument >>> 16) & 255,
            (argument >>> 8) & 255,
            argument & 255,
            index === 0 ? 0x95 : 0x87,
          ])
            await exchange(byte);
          return response();
        };
        const initialize = async () => {
          await setup();
          expect(await command(0)).toBe(1);
          expect(await command(8, 0x1aa)).toBe(1);
          for (let n = 0; n < 4; n++) await exchange(255);
          let ready = false;
          for (let n = 0; n < 20; n++) {
            await command(55);
            if ((await command(41, 0x40000000)) === 0) {
              ready = true;
              break;
            }
          }
          expect(ready).toBe(true);
          expect(await command(16, 512)).toBe(0);
        };
        const payload = Buffer.from(
          Array.from({ length: 512 }, (_, i) => (i * 7 + 0x31) & 255),
        );
        await controller.load(target.path);
        await initialize();
        expect(await command(24, 512)).toBe(0); // 32 MiB SDSC uses byte addresses
        await exchange(255);
        await exchange(255);
        await exchange(0xfe);
        for (const byte of payload) await exchange(byte);
        await exchange(255);
        await exchange(255);
        expect((await response()) & 0x1f).toBe(5);
        await exchange(255);
        await exchange(255);
        await controller.stop();
        const cardPath = join(
          root,
          "data",
          "kernels",
          "gwemu",
          "sessions",
          target.id,
          "sdcard.img",
        );
        const saved = await open(cardPath, "r");
        const bytes = Buffer.alloc(512);
        await saved.read(bytes, 0, 512, 512);
        await saved.close();
        expect(bytes).toEqual(payload);
        await controller.load(target.path);
        await initialize();
        expect(await command(17, 512)).toBe(0);
        expect(await response()).toBe(0xfe);
        const restored = Buffer.alloc(512);
        for (let n = 0; n < 512; n++) restored[n] = await exchange(255);
        expect(restored).toEqual(payload);
        await exchange(255);
        await exchange(255);
        await controller.stop();
      }
      const sourceCard = await open(join(root, "sd.img"), "r");
      const sourceSector = Buffer.alloc(512);
      await sourceCard.read(sourceSector, 0, 512, 512);
      await sourceCard.close();
      expect(sourceSector).toEqual(Buffer.alloc(512));
      expect(await readFile(profile.internalFlash)).toEqual(internal);
      expect(await readFile(profile.externalFlash)).toEqual(external);
    } finally {
      await controller.stop().catch(() => {});
      args.mockRestore();
      await rm(sockets, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
