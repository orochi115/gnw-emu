import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createProfile } from "../../src/core/profile-store";

test.skip(
  !existsSync(resolve("../build/gwemu-softspi/qemu-system-arm")),
  "Build the fixed gwemu desktop kernel first",
);
test("gwemu renders in the real desktop, handles input and mute, changes ROM and closes", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "gnw-gwemu-ui-"));
  const internal = resolve("../../firmware/internal_flash_backup_zelda.bin");
  const external = resolve("../../firmware/flash_backup_zelda.bin");
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const initial = [await hash(internal), await hash(external)];
  const profile = await createProfile(join(root, "zelda.gnw.json"), {
    model: "zelda",
    internalFlash: internal,
    externalFlash: external,
    deviceUid: "310047000b51333138343134",
  });
  const app = await electron.launch({
    args: [
      resolve("."),
      "--language=zh-CN",
      "--automation",
      "--test-dialogs",
      `--user-data-dir=${root}`,
      profile.path,
    ],
    env: { ...process.env, GNW_KERNEL: "gwemu" },
  });
  let closed = false;
  try {
    const page = await app.firstWindow();
    let endpoint: any;
    await expect
      .poll(async () => {
        try {
          endpoint = JSON.parse(
            await readFile(join(root, "automation.json"), "utf8"),
          );
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const rpc = async (method: string, params: any = {}) => {
      const result: any = await (
        await fetch(endpoint.url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    };
    const action = async (method: string, params: any) => {
      const result = await rpc(method, params);
      let operation: any;
      await expect
        .poll(
          async () => {
            operation = await rpc("automation.getOperation", {
              operationId: result.operationId,
            });
            return operation.status;
          },
          { timeout: 20000 },
        )
        .not.toBe("pending");
      expect(operation.error, JSON.stringify(operation)).toBeUndefined();
      return operation.result;
    };
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    const state = await rpc("app.getState");
    expect(state.canInstantState).toBe(false);
    await expect
      .poll(async () => Number((await rpc("app.getDiagnostics")).frames))
      .toBeGreaterThan(5);
    expect((await rpc("app.getDiagnostics")).width).toBe(640);
    const waitForPanel = () =>
      expect
        .poll(
          () =>
            page.locator("canvas").evaluate((canvas: any) => {
              const pixels = canvas
                .getContext("2d")
                .getImageData(0, 0, canvas.width, canvas.height).data;
              let lit = 0;
              for (let i = 0; i < pixels.length; i += 4)
                if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++;
              return lit;
            }),
          { timeout: 15000 },
        )
        // The initial QEMU "Guest has not initialized" text also has lit pixels.
        // Require a substantial rendered panel before capturing the preview.
        .toBeGreaterThan(20000);
    await waitForPanel();
    const output = resolve("../out/gwemu-softspi-sd");
    await mkdir(output, { recursive: true });
    await rpc("ui.screenshot", { path: join(output, "zelda-desktop.png") });
    await action("ui.key", { key: "Left", down: true });
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).input.appliedMask)
      .toBe(1);
    // A real modal takes focus away from emulation and must release held keys.
    await action("ui.menu", { id: "file.make" });
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).input.appliedMask)
      .toBe(0);
    await action("ui.click", { id: "rom.cancel" });
    const muted = (await rpc("app.getDiagnostics")).audioMuted;
    await action("ui.menu", { id: "audio.mute" });
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).audioMuted)
      .toBe(!muted);
    await action("ui.menu", { id: "audio.mute" });
    const enabled = await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()!.getMenuItemById("state.save")!.enabled,
    );
    expect(enabled).toBe(false);
    await action("ui.key", { key: "-", down: true });
    await action("ui.key", { key: "-", down: false });
    await action("ui.key", { key: "-", down: true });
    await action("ui.key", { key: "-", down: false });
    await action("ui.key", { key: "C", down: true });
    await action("ui.key", { key: "C", down: false });
    const mario = await createProfile(join(root, "mario.gnw.json"), {
      model: "mario",
      internalFlash: resolve("../../firmware/internal_flash_backup_mario.bin"),
      externalFlash: resolve("../../firmware/flash_backup_mario.bin"),
    });
    await rpc("automation.queueDialogResponse", {
      kind: "open",
      path: mario.path,
    });
    await action("ui.menu", { id: "file.open" });
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    expect((await rpc("app.getState")).runtimeSessionId).not.toBe(
      state.runtimeSessionId,
    );
    await expect
      .poll(async () => Number((await rpc("app.getDiagnostics")).frames))
      .toBeGreaterThan(50);
    await waitForPanel();
    await rpc("ui.screenshot", { path: join(output, "mario-desktop.png") });
    const statePath = join(
      root,
      "kernels",
      "gwemu",
      "sessions",
      profile.id,
      "session.json",
    );
    const savedPower = JSON.parse(await readFile(statePath, "utf8"));
    expect(savedPower.battery).toBe(80);
    expect(savedPower.usbPower).toBe(true);
    // Reopen the same isolated Zelda session, then adjust its restored state.
    await rpc("automation.queueDialogResponse", {
      kind: "open",
      path: profile.path,
    });
    await action("ui.menu", { id: "file.open" });
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    await action("ui.key", { key: "=", down: true });
    await action("ui.key", { key: "=", down: false });
    await action("ui.key", { key: "C", down: true });
    await action("ui.key", { key: "C", down: false });
    const pid = (await rpc("app.getDiagnostics")).qemuPid;
    await app.close();
    closed = true;
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
    const finalPower = JSON.parse(await readFile(statePath, "utf8"));
    expect(finalPower.battery).toBe(90);
    expect(finalPower.usbPower).toBe(false);
    expect([await hash(internal), await hash(external)]).toEqual(initial);
    expect(existsSync(join(root, "sessions"))).toBe(false);
  } finally {
    if (!closed) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
