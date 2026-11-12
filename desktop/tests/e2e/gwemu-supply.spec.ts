import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createProfile } from "../../src/core/profile-store";

test.skip(
  !existsSync(resolve("../build/gwemu-savestate/qemu-system-arm")),
  "Build gwemu-savestate first",
);
test("desktop supply loss, off reopen, explicit resume and cold startup", async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), "gnw-desktop-supply-"));
  const internal = resolve("../../firmware/internal_flash_backup_zelda.bin");
  const external = resolve("../../firmware/flash_backup_zelda.bin");
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const original = await Promise.all([hash(internal), hash(external)]);
  const profile = await createProfile(join(root, "zelda.gnw.json"), {
    model: "zelda",
    internalFlash: internal,
    externalFlash: external,
    deviceUid: "310047000b51333138343134",
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const launch = async () => {
    app = await electron.launch({
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
      const started = await rpc(method, params);
      let result: any;
      await expect
        .poll(
          async () => {
            result = await rpc("automation.getOperation", {
              operationId: started.operationId,
            });
            return result.status;
          },
          { timeout: 20000 },
        )
        .not.toBe("pending");
      expect(result.error, JSON.stringify(result)).toBeUndefined();
      return result.result;
    };
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    const menu = (id: string) => action("ui.menu", { id });
    const execution = (value: string) =>
      expect
        .poll(async () => (await rpc("app.getState")).execution)
        .toBe(value);
    const rendered = () =>
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
        .toBeGreaterThan(20000);
    return { page, rpc, action, menu, execution, rendered };
  };
  try {
    let ui = await launch();
    const firstId = (await ui.rpc("app.getState")).runtimeSessionId;
    await ui.execution("running");
    await ui.rendered();
    await ui.menu("device.usb");
    await ui.menu("device.batteryPresent");
    await ui.execution("running"); // redundant supply removal does not pause
    expect((await ui.rpc("app.getState")).devicePower.batteryPresent).toBe(
      false,
    );
    await ui.action("ui.key", { key: "Left", down: true });
    await expect
      .poll(async () => (await ui.rpc("app.getDiagnostics")).input.appliedMask)
      .toBe(1);
    await ui.menu("device.usb"); // last source disappears
    await ui.execution("unpowered");
    await expect
      .poll(async () => (await ui.rpc("app.getDiagnostics")).input.appliedMask)
      .toBe(0);
    await expect(ui.page.locator('[data-ui="device-execution"]')).toBeVisible();
    await expect(
      ui.page.locator('[data-ui="chassis.button.left"]'),
    ).toBeDisabled();
    const unavailable = await app!.evaluate(({ Menu }) =>
      ["device.resume", "device.coldStart"].map(
        (id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled,
      ),
    );
    expect(unavailable).toEqual([false, false]);
    const firstPid = (await ui.rpc("app.getDiagnostics")).qemuPid;
    await app!.close();
    app = undefined;
    expect(() => process.kill(firstPid, 0)).toThrow();
    const metadata = join(
      root,
      "kernels",
      "gwemu",
      "sessions",
      profile.id,
      "session.json",
    );
    expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({
      batteryPresent: false,
      usbPower: false,
    });
    ui = await launch();
    await ui.execution("unpowered");
    expect((await ui.rpc("app.getState")).runtimeSessionId).not.toBe(firstId);
    // Existing USB hotkey remains available while ordinary device input is blocked.
    await ui.action("ui.key", { key: "C", down: true });
    await ui.action("ui.key", { key: "C", down: false });
    await ui.execution("paused");
    await expect(
      ui.page.locator('[data-ui="chassis.button.left"]'),
    ).toBeDisabled();
    await ui.action("ui.key", { key: "Left", down: true });
    await ui.action("ui.key", { key: "Left", down: false });
    expect((await ui.rpc("app.getDiagnostics")).input.appliedMask).toBe(0);
    await ui.menu("device.resume");
    await ui.execution("running");
    await expect(
      ui.page.locator('[data-ui="chassis.button.left"]'),
    ).toBeEnabled();
    await ui.rendered();
    await ui.menu("device.pause");
    await ui.execution("paused");
    const framesBeforeCold = Number(
      (await ui.rpc("app.getDiagnostics")).frames,
    );
    await ui.menu("device.coldStart");
    await ui.execution("running");
    await expect
      .poll(async () => Number((await ui.rpc("app.getDiagnostics")).frames))
      .toBeGreaterThan(framesBeforeCold + 5);
    await ui.rendered();
    await ui.menu("view.clock");
    const clockMenu = await ui.rpc("ui.inspect");
    expect(
      clockMenu.contextMenus.find(
        (item: any) => item.id === "device.batteryPresent",
      ),
    ).toMatchObject({ enabled: true, checked: false });
    await ui.action("ui.contextMenu", { id: "device.batteryPresent" });
    await ui.execution("running");
    await ui.menu("view.clock");
    await ui.rendered();
    await mkdir(resolve("../out/gwemu-desktop-supply"), { recursive: true });
    await ui.rpc("ui.screenshot", {
      path: resolve("../out/gwemu-desktop-supply/restored.png"),
    });
    const pid = (await ui.rpc("app.getDiagnostics")).qemuPid;
    await app!.close();
    app = undefined;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({
      batteryPresent: true,
      usbPower: true,
    });
    expect(existsSync(join(root, "sessions"))).toBe(false);
  } finally {
    await app?.close();
    expect(await Promise.all([hash(internal), hash(external)])).toEqual(
      original,
    );
    await rm(root, { recursive: true, force: true });
  }
});
