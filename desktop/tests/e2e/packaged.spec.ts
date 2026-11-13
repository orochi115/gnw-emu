import { test, expect, _electron as electron } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
test("directory package includes relocatable QEMU and explicit automation", async () => {
  test.skip(
    process.env.GNW_PACKAGE_TEST !== "1",
    "Explicit native directory package smoke test",
  );
  const root = await mkdtemp(join(tmpdir(), "gnw-package-"));
  const profile = join(root, "rom.gnw.json");
  await writeFile(
    profile,
    JSON.stringify({
      formatVersion: 1,
      id: randomUUID(),
      model: "zelda",
      internalFlash: resolve("../../firmware/internal_flash_backup_zelda.bin"),
      externalFlash: resolve("../../firmware/flash_backup_zelda.bin"),
    }),
  );
  const binary =
    process.env.GNW_PACKAGE_BINARY ??
    resolve("release/mac-arm64/gnw-emu.app/Contents/MacOS/gnw-emu");
  const app = await electron.launch({
    executablePath: binary,
    args: [
      "--language=zh-CN",
      "--automation",
      `--user-data-dir=${root}`,
      profile,
    ],
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("main")).toHaveAttribute(
      "data-status",
      "running",
      { timeout: 15000 },
    );
    const endpoint = JSON.parse(
      await readFile(join(root, "automation.json"), "utf8"),
    );
    const reply = (await (
      await fetch(endpoint.url, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.getState" }),
      })
    ).json()) as any;
    expect(reply.result.status).toBe("running");
    await expect(page.locator('[data-ui="chassis"]')).toHaveAttribute(
      "data-model",
      "zelda",
    );
    await expect
      .poll(() =>
        page
          .locator(".chassis-frame")
          .evaluate(
            (image: any) => image.complete && image.naturalWidth === 950,
          ),
      )
      .toBe(true);
    for (const method of [
      "automation.capabilities",
      "ui.inspect",
      "logging.getConfig",
      "logging.tail",
    ]) {
      const cliReply = JSON.parse(
        execFileSync(
          process.execPath,
          [
            resolve("dist-cli/ui-cli.js"),
            join(root, "automation.json"),
            method,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(cliReply.error).toBeUndefined();
      expect(cliReply.result).toBeDefined();
    }
    await expect
      .poll(() =>
        page
          .locator("canvas")
          .evaluate((e) => Number((e as HTMLElement).dataset.frames)),
      )
      .toBeGreaterThan(2);
    const runtimeId = reply.result.runtimeSessionId;
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.getMenuItemById("view.clock")!.click(),
    );
    await expect(page.locator("main")).toHaveClass("desktop-clock");
    expect(
      await page.evaluate(() => window.desktop.windowState()),
    ).toMatchObject({ pixelPerfect: true });
    await expect
      .poll(() =>
        page.locator("canvas").evaluate((c) => {
          const r = c.getBoundingClientRect(),
            d = window.devicePixelRatio;
          return {
            width: Math.round(r.width * d),
            height: Math.round(r.height * d),
          };
        }),
      )
      .toEqual({ width: 320, height: 240 });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isAlwaysOnTop(),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.desktop.state())).toMatchObject({
      runtimeSessionId: runtimeId,
    });
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.getMenuItemById("view.scale.half")!.click(),
    );
    await expect
      .poll(() =>
        page.locator("canvas").evaluate((c) => {
          const r = c.getBoundingClientRect();
          return Math.round(r.width * devicePixelRatio);
        }),
      )
      .toBe(160);
    await expect
      .poll(() => page.evaluate(() => window.desktop.windowState()))
      .toMatchObject({ clockScale: 0.5, preferredClockMode: true });
    // The renderer receives geometry before the settings transaction finishes.
    // Wait for the public menu readiness gate before issuing another action.
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!.getMenuItemById("view.clock")!.enabled,
        ),
      )
      .toBe(true);
    await page.evaluate(() => window.desktop.windowAction("normal"));
    await expect(page.locator("main")).toHaveClass("normal-window");
    await expect(page.locator("canvas")).toHaveAttribute(
      "data-runtime-session-id",
      runtimeId,
    );
    // Original controls photographs and settings transactions also ship in the package.
    const opening = app.waitForEvent("window");
    await page.evaluate(() => window.desktop.openControls());
    const controls = await opening;
    await expect(controls.locator('[data-ui="controls.dialog"]')).toBeVisible();
    await expect
      .poll(() =>
        controls
          .locator(".controls-hardware")
          .evaluate((im: any) => im.complete && im.naturalWidth > 900),
      )
      .toBe(true);
    const config = await page.evaluate(() => window.desktop.controls());
    const binding = config.bindings.find(
      (b) => b.target === "a" && b.inputs[0].kind === "keyboard",
    )!;
    await controls
      .locator(`[data-ui="controls.binding.${binding.id}"]`)
      .click();
    await controls.locator('[data-ui="controls.capture"]').click();
    await controls.keyboard.press("k");
    await controls.locator('[data-ui="controls.detail.done"]').click();
    await controls.locator('[data-ui="controls.save"]').click();
    await expect.poll(() => controls.isClosed()).toBe(true);
    const saved = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    );
    expect(
      saved.controls.bindings.find((b: any) => b.id === binding.id).inputs,
    ).toEqual([{ kind: "keyboard", code: "KeyK" }]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.keyboard.down("k");
    await expect
      .poll(() => page.evaluate(() => window.desktop.inputState()))
      .toMatchObject({ desiredMask: 16, appliedMask: 16 });
    await page.keyboard.up("k");
    await expect
      .poll(() => page.evaluate(() => window.desktop.inputState()))
      .toMatchObject({ desiredMask: 0, appliedMask: 0 });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("default package starts idle, exposes manager, and persists USB-only supply with staged state identity", async () => {
  test.skip(
    process.env.GNW_PACKAGE_TEST !== "1",
    "Explicit native directory package smoke test",
  );
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-package-session-"));
  const id = randomUUID();
  const profile = join(root, "mario.gnw.json");
  await writeFile(
    profile,
    JSON.stringify({
      formatVersion: 1,
      id,
      model: "mario",
      internalFlash: resolve("../../firmware/internal_flash_backup_mario.bin"),
      externalFlash: resolve("../../firmware/flash_backup_mario.bin"),
    }),
  );
  const binary =
    process.env.GNW_PACKAGE_BINARY ??
    resolve("release/mac-arm64/gnw-emu.app/Contents/MacOS/gnw-emu");
  const resources = resolve(binary, "../../Resources/qemu");
  const manifest = JSON.parse(
    await readFile(join(resources, "gnw-package-manifest.json"), "utf8"),
  );
  const { createHash } = await import("node:crypto");
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  expect(await hash(join(resources, "qemu-system-arm"))).toBe(
    manifest.stagedSha256,
  );
  expect(await hash(join(resources, "gnw-build-manifest.json"))).toBe(
    manifest.sourceManifestSha256,
  );
  for (const [name, sha] of Object.entries(manifest.libraries))
    expect(await hash(join(resources, name)), name).toBe(sha);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let endpoint: any;
  const rpc = async (method: string, params: any = {}) => {
    const reply: any = await (
      await fetch(endpoint.url, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(5000),
      })
    ).json();
    expect(reply.error, JSON.stringify(reply)).toBeUndefined();
    return reply.result;
  };
  const menu = async (id: string) => {
    if (id.startsWith("state.")) {
      await app!.evaluate(({ Menu }, itemId) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById(itemId)!;
        if (!item.enabled) throw new Error("State menu item disabled");
        item.click();
      }, id);
      await expect.poll(async () => (await rpc("app.getState")).stateOperation).toBeUndefined();
      return;
    }
    const result = await rpc("ui.menu", { id });
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
  };
  const start = async (withProfile: boolean) => {
    app = await electron.launch({
      executablePath: binary,
      args: [
        "--automation",
        "--test-dialogs",
        `--user-data-dir=${root}`,
        ...(withProfile ? [profile] : []),
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => key !== "GNW_KERNEL" && value !== undefined,
        ),
      ) as Record<string, string>,
    });
    await app.firstWindow();
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
  };
  try {
    await start(false);
    expect((await rpc("app.getState")).status).toBe("idle");
    expect((await rpc("app.getDiagnostics")).qemuPid).toBeUndefined();
    await rpc("automation.queueDialogResponse", {
      kind: "open",
      path: profile,
    });
    await menu("file.open");
    await expect
      .poll(async () => (await rpc("app.getState")).status)
      .toBe("running");
    const initialId = (await rpc("app.getState")).runtimeSessionId;
    const python = resolve("../build/gnwmanager-python/bin/python");
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const result = await promisify(execFile)(
      python,
      ["-m", "gnwmanager", "--session", initialId, "info"],
      {
        cwd: resolve("../externals/gnwmanager"),
        timeout: 30000,
      },
    );
    expect(result.stdout).toMatch(/Detected Stock Firmware:\s+MARIO/);
    await menu("device.usb");
    await menu("device.batteryPresent");
    await expect
      .poll(async () => (await rpc("app.getState")).devicePower)
      .toMatchObject({
        powered: true,
        usbPower: true,
        batteryPresent: false,
      });
    await menu("state.save");
    const session = join(root, "kernels/gwemu/sessions", id);
    let slot: any;
    await expect.poll(async () => {
      try { slot = JSON.parse(await readFile(join(session, "states-gwemu/slot-0.json"), "utf8")); return true; }
      catch { return false; }
    }).toBe(true);
    expect(slot).toMatchObject({
      kernel: "gwemu",
      version: 2,
      buildSha256: manifest.stagedSha256,
    });
    await app!.close();
    app = undefined;
    expect(
      JSON.parse(await readFile(join(session, "session.json"), "utf8")),
    ).toMatchObject({
      usbPower: true,
      batteryPresent: false,
    });
    await start(true);
    await expect
      .poll(async () => (await rpc("app.getState")).status)
      .toBe("running");
    const reopened = await rpc("app.getState");
    expect(reopened.runtimeSessionId).not.toBe(initialId);
    expect(reopened.devicePower).toMatchObject({
      powered: true,
      usbPower: true,
      batteryPresent: false,
    });
    await menu("state.load");
    expect((await rpc("app.getState")).saveUncertain).not.toBe(true);
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
