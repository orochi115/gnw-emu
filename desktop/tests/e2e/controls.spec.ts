import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function launch(root: string, model = "zelda") {
  const app = await electron.launch({
    args: [
      resolve("."),
      "--language=zh-CN",
      "--automation",
      "--test-dialogs",
      `--user-data-dir=${root}`,
      resolve(`../profiles/${model}.gnw.json`),
    ],
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
    const response: any = await (
      await fetch(endpoint.url, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json();
    if (response.error) throw Error(JSON.stringify(response.error));
    return response.result;
  };
  await expect(page.locator("main")).toHaveAttribute("data-status", "running", {
    timeout: 20000,
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  const mask = async (value: number) => {
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).input)
      .toMatchObject({ desiredMask: value, appliedMask: value });
  };
  const open = async () => {
    await page.evaluate(() => window.desktop.openControls());
    await expect(page.locator('[data-ui="controls.dialog"]')).toBeVisible();
    await mask(0);
  };
  return { app, page, rpc, mask, open };
}
const selector = (id: string) => `[data-ui="${id}"]`;
async function rebind(page: Page, target: string, key: string) {
  const config = await page.evaluate(() => window.desktop.controls());
  const binding = config.bindings.find(
    (b) => b.target === target && b.inputs[0].kind === "keyboard",
  )!;
  await page.locator(selector(`controls.binding.${binding.id}`)).click();
  await page.keyboard.press(key);
  await expect(page.locator(selector("controls.capture"))).not.toHaveClass(
    /listening/,
  );
  await page.locator(selector("controls.detail.done")).click();
  return binding.id;
}

test("controls draft capture stays neutral, commits JSON, and is reused by Mario after restart", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-"));
  let live = await launch(root);
  try {
    const original = await live.page.evaluate(() => window.desktop.controls());
    const geometry = await live.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
    await live.page.keyboard.down("x");
    await live.mask(16);
    await live.open();
    await live.page.keyboard.up("x");
    const properties = (await live.rpc("app.getDiagnostics")).audio;
    await rebind(live.page, "a", "k");
    await live.mask(0);
    expect((await live.rpc("app.getDiagnostics")).audio).toEqual(properties);
    await live.page.locator(selector("controls.cancel")).click();
    expect(await live.page.evaluate(() => window.desktop.controls())).toEqual(
      original,
    );
    await expect
      .poll(() =>
        live.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getBounds(),
        ),
      )
      .toEqual(geometry);
    await live.open();
    const id = await rebind(live.page, "a", "k");
    await live.page.locator(selector("controls.model.mario")).click();
    await expect(
      live.page.locator(selector("controls.diagram.mario")),
    ).toBeVisible();
    await expect(
      live.page.locator(selector("controls.target.start")),
    ).toBeVisible();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    const saved = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    );
    expect(
      saved.controls.bindings.find((b: any) => b.id === id).inputs,
    ).toEqual([{ kind: "keyboard", code: "KeyK" }]);
    await live.page.keyboard.down("x");
    await live.mask(0);
    await live.page.keyboard.up("x");
    await live.page.keyboard.down("k");
    await live.mask(16);
    await live.page.keyboard.up("k");
    await live.mask(0);
    await live.app.close();
    live = await launch(root, "mario");
    expect(await live.page.evaluate(() => window.desktop.controls())).toEqual(
      saved.controls,
    );
    await live.page.keyboard.down("k");
    await live.mask(16);
    await live.page.keyboard.up("k");
    await live.mask(0);
    await live.open();
    await expect(
      live.page.locator(selector("controls.diagram.mario")),
    ).toBeVisible();
  } finally {
    await live.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("held capture keys cannot leak after close, turbo pulses, and modified hotkeys share conflict markers", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-runtime-"));
  const live = await launch(root);
  try {
    await live.open();
    const config = await live.page.evaluate(() => window.desktop.controls());
    const binding = config.bindings.find(
      (b) => b.target === "a" && b.inputs[0].kind === "keyboard",
    )!;
    await live.page.locator(selector(`controls.binding.${binding.id}`)).click();
    await live.page.keyboard.down("j");
    await expect(
      live.page.locator(selector("controls.capture")),
    ).not.toHaveClass(/listening/);
    await live.page.locator(selector("controls.detail.done")).click();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    await live.mask(0);
    await live.page.keyboard.up("j");
    await live.page.keyboard.down("j");
    await live.mask(16);
    await live.page.keyboard.up("j");
    await live.mask(0);
    await live.open();
    await live.page.locator(selector("controls.add.a")).click();
    await live.page.keyboard.press("Space");
    await live.page.locator(selector("controls.detail.done")).click();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    await live.page.locator(selector("chassis.button.b")).focus();
    await live.page.keyboard.down("Space");
    await live.mask(16);
    await live.page.keyboard.up("Space");
    await live.mask(0);
    await live.open();
    await live.page.locator(selector(`controls.binding.${binding.id}`)).click();
    await live.page
      .locator(selector("controls.detail"))
      .getByRole("radio", { name: "10 次/秒", exact: true })
      .click();
    await live.page.locator(selector("controls.detail.done")).click();
    await live.page.locator(selector("controls.page.hotkeys")).click();
    await live.page.locator(selector("controls.add.audio.mute")).click();
    await live.page.keyboard.press("Shift+j");
    await expect(
      live.page.locator(selector("controls.capture")),
    ).not.toHaveClass(/listening/);
    await expect(live.page.locator(".controls-conflicts")).toBeVisible();
    await live.page.locator(selector("controls.detail.done")).click();
    await expect(
      live.page
        .locator(selector("controls.action.audio.mute"))
        .locator(".controls-conflict-mark"),
    ).toHaveCount(1);
    await live.page.locator(selector("controls.page.buttons")).click();
    await expect(
      live.page
        .locator(selector(`controls.binding.${binding.id}`))
        .locator(".controls-conflict-mark"),
    ).toBeVisible();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    const masks = await live.page.evaluate(async () => {
      const samples: number[] = [];
      const off = window.desktop.onInput((v) => samples.push(v.appliedMask));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyJ", bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 420));
      window.dispatchEvent(
        new KeyboardEvent("keyup", { code: "KeyJ", bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 100));
      off();
      return samples;
    });
    expect(masks.filter((v) => v === 16).length).toBeGreaterThanOrEqual(3);
    expect(masks.filter((v) => v === 0).length).toBeGreaterThanOrEqual(3);
    await live.mask(0);
    const muted = (await live.rpc("app.getDiagnostics")).audio.muted;
    await live.page.keyboard.press("Shift+j");
    await expect
      .poll(async () => (await live.rpc("app.getDiagnostics")).audio.muted)
      .toBe(!muted);
    await live.page.keyboard.press("Control+Shift+j");
    expect((await live.rpc("app.getDiagnostics")).audio.muted).toBe(!muted);
  } finally {
    await live.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed settings write retains draft and main input isolation", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-failure-"));
  const live = await launch(root);
  try {
    await live.open();
    const original = await live.page.evaluate(() => window.desktop.controls());
    await rebind(live.page, "a", "k");
    await rename(join(root, "settings.json"), join(root, "settings.saved"));
    await mkdir(join(root, "settings.json"));
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(".controls-save-error")).toBeVisible();
    expect((await live.rpc("app.getDiagnostics")).controls.isolated).toBe(true);
    expect(await live.page.evaluate(() => window.desktop.controls())).toEqual(
      original,
    );
    await live.page.evaluate(async () => {
      const state = await window.desktop.state();
      window.desktop.key("KeyX", true);
      window.desktop.button(4, true, "pointer:99", state.runtimeSessionId!);
    });
    await live.page.keyboard.press("x");
    await live.mask(0);
    await rm(join(root, "settings.json"), { recursive: true });
    await rename(join(root, "settings.saved"), join(root, "settings.json"));
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    await live.page.keyboard.down("k");
    await live.mask(16);
    await live.page.keyboard.up("k");
    await live.mask(0);
  } finally {
    await live.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gamepad API inputs aggregate with keyboard and record controller chords", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-pad-"));
  const live = await launch(root);
  const snapshot = async (pressed: number[] = [], axis = 0) => {
    await live.page.evaluate(
      async ({ pressed, axis }) => {
        (window as any).__pads = [
          {
            index: 0,
            id: "Test controller",
            mapping: "standard",
            connected: true,
            axes: [axis, 0],
            buttons: Array.from({ length: 16 }, (_, i) => ({
              pressed: pressed.includes(i),
              value: pressed.includes(i) ? 1 : 0,
            })),
          },
        ];
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
        );
      },
      { pressed, axis },
    );
  };
  try {
    const hardware = await live.page.evaluate(() =>
      Array.from(navigator.getGamepads())
        .filter(Boolean)
        .map((p) => p!.id),
    );
    console.log(
      `Physical gamepads exposed by Chromium: ${JSON.stringify(hardware)}`,
    );
    await live.page.evaluate(() =>
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => (window as any).__pads ?? [],
      }),
    );
    await snapshot();
    await snapshot([0]);
    await live.mask(16);
    await live.page.keyboard.down("x");
    await snapshot();
    await live.mask(16);
    await live.page.keyboard.up("x");
    await live.mask(0);
    await snapshot([], -0.7);
    await live.mask(1);
    await snapshot([14]);
    await live.mask(1);
    await snapshot();
    await live.mask(0);
    await live.open();
    await live.page.locator(selector("controls.devices")).click();
    await live.page
      .locator('.controls-device-panel input[type="checkbox"]')
      .uncheck();
    await live.page.locator(selector("controls.cancel")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    await snapshot();
    await snapshot([0]);
    await live.mask(16);
    await snapshot();
    await live.mask(0);
    await live.open();
    await live.page.locator(selector("controls.devices")).click();
    await expect(live.page.locator(".controls-device-panel")).toContainText(
      "Test controller",
    );
    await live.page.locator(".controls-device-panel header button").click();
    await live.page.locator(selector("controls.page.hotkeys")).click();
    await live.page.locator(selector("controls.add.audio.mute")).click();
    await snapshot([4]);
    await snapshot([4, 5]);
    await snapshot();
    await expect(
      live.page.locator(selector("controls.capture")),
    ).not.toHaveClass(/listening/);
    await live.page.locator(selector("controls.detail.done")).click();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    const config = await live.page.evaluate(() => window.desktop.controls());
    expect(
      config.bindings.find((b) => b.target === "audio.mute")?.inputs,
    ).toHaveLength(2);
    const muted = (await live.rpc("app.getDiagnostics")).audio.muted;
    await snapshot([4]);
    expect((await live.rpc("app.getDiagnostics")).audio.muted).toBe(muted);
    await snapshot([4, 5]);
    await expect
      .poll(async () => (await live.rpc("app.getDiagnostics")).audio.muted)
      .toBe(!muted);
    await snapshot();
    await live.open();
    await live.page.locator(selector("controls.model.zelda")).click();
    await live.page.screenshot({
      path: resolve("../out/ui-validation/controls-zelda.png"),
    });
    await live.page.locator(selector("controls.model.mario")).click();
    await live.page.screenshot({
      path: resolve("../out/ui-validation/controls-mario.png"),
    });
    await live.page.locator(selector("controls.page.hotkeys")).click();
    await live.page.screenshot({
      path: resolve("../out/ui-validation/controls-hotkeys.png"),
    });
  } finally {
    await live.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer reload abandons capture and restores game geometry", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-reload-"));
  const live = await launch(root);
  try {
    const original = await live.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
    await live.open();
    await live.page.reload();
    await expect(live.page.locator("main")).toHaveAttribute(
      "data-status",
      "running",
    );
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    await expect
      .poll(() =>
        live.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getBounds(),
        ),
      )
      .toEqual(original);
    expect((await live.rpc("app.getDiagnostics")).controls.isolated).toBe(
      false,
    );
    await live.page.keyboard.down("x");
    await live.mask(16);
    await live.page.keyboard.up("x");
    await live.mask(0);
  } finally {
    await live.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("configured hotkey replaces native shortcut and deletion removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-hotkey-"));
  const live = await launch(root);
  try {
    await live.open();
    await live.page.locator(selector("controls.page.hotkeys")).click();
    const config = await live.page.evaluate(() => window.desktop.controls());
    const binding = config.bindings.find((b) => b.target === "file.make")!;
    await live.page.locator(selector(`controls.binding.${binding.id}`)).click();
    await live.page.keyboard.press("Shift+m");
    await live.page.locator(selector("controls.detail.done")).click();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    const shortcut = await live.app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()!.getMenuItemById("file.make")!.accelerator,
    );
    expect(shortcut).toBe("Shift+M");
    await live.page.keyboard.press(
      process.platform === "darwin" ? "Meta+n" : "Control+n",
    );
    await live.page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
        ),
    );
    await expect(live.page.locator("dialog[open]")).toHaveCount(0);
    await live.page.keyboard.press("Shift+m");
    await expect(live.page.locator(selector("rom.cancel"))).toBeVisible();
    await live.page.locator(selector("rom.cancel")).click();
    await live.open();
    await live.page.locator(selector("controls.page.hotkeys")).click();
    await live.page.locator(selector(`controls.binding.${binding.id}`)).click();
    await live.page.locator(selector("controls.detail.delete")).click();
    await live.page.locator(selector("controls.save")).click();
    await expect(live.page.locator(selector("controls.dialog"))).toHaveCount(0);
    expect(
      await live.app.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()!.getMenuItemById("file.make")!.accelerator,
      ),
    ).toBeNull();
    await live.page.keyboard.press("Shift+m");
    await live.page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
        ),
    );
    await expect(live.page.locator("dialog[open]")).toHaveCount(0);
  } finally {
    await live.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
