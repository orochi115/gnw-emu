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
