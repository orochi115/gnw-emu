import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

async function launch(root: string, model?: string) {
  const app = await electron.launch({
    args: [
      resolve("."),
      "--language=zh-CN",
      "--automation",
      "--test-dialogs",
      `--user-data-dir=${root}`,
      ...(model ? [resolve(`../profiles/${model}.gnw.json`)] : []),
    ],
  });
  const page = await app.firstWindow();
  let ep: any;
  await expect
    .poll(async () => {
      try {
        ep = JSON.parse(await readFile(join(root, "automation.json"), "utf8"));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const rpc = async (method: string, params: any = {}) => {
    const response: any = await (
      await fetch(ep.url, {
        method: "POST",
        headers: { authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json();
    if (response.error) throw Error(JSON.stringify(response.error));
    return response.result;
  };
  const action = async (method: string, params: any) => {
    const start = await rpc(method, params);
    let done: any;
    await expect
      .poll(
        async () => {
          done = await rpc("automation.getOperation", {
            operationId: start.operationId,
          });
          return done.status;
        },
        { timeout: 20000 },
      )
      .not.toBe("pending");
    if (done.error) throw Error(JSON.stringify(done.error));
    return done.result;
  };
  await rpc("logging.configure", { modules: { input: "debug" } });
  return { app, page, rpc, action };
}
async function aligned(page: Page) {
  const rectangles = await page.evaluate(() => {
    const chassis = document
      .querySelector('[data-ui="chassis"]')!
      .getBoundingClientRect();
    const canvas = document.querySelector("canvas")!.getBoundingClientRect();
    const model = document
      .querySelector('[data-ui="chassis"]')!
      .getAttribute("data-model");
    return {
      chassis: {
        x: chassis.x,
        y: chassis.y,
        width: chassis.width,
        height: chassis.height,
      },
      canvas: {
        x: canvas.x,
        y: canvas.y,
        width: canvas.width,
        height: canvas.height,
      },
      model,
    };
  });
  const { chassis: c, canvas: l } = rectangles;
  const [width, height, x, y, w, h] =
    rectangles.model === "zelda"
      ? [950, 567, 267, 129, 416, 312]
      : [919, 550, 258, 124, 404, 303];
  expect(l.x).toBeCloseTo(c.x + (x / width) * c.width, 0);
  expect(l.y).toBeCloseTo(c.y + (y / height) * c.height, 0);
  expect(l.width).toBeCloseTo((w / width) * c.width, 0);
  expect(l.height).toBeCloseTo((h / height) * c.height, 0);
  expect(l.width / l.height).toBeCloseTo(4 / 3, 2);
  expect(c.width / c.height).toBeCloseTo(width / height, 2);
}

async function actualPixels(page: Page) {
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
  const origin = await page.locator("canvas").evaluate((c) => {
    const r = c.getBoundingClientRect(),
      d = window.devicePixelRatio;
    return { x: r.x * d, y: r.y * d };
  });
  expect(origin.x).toBeCloseTo(Math.round(origin.x), 1);
  expect(origin.y).toBeCloseTo(Math.round(origin.y), 1);
}

async function pixelPattern(app: ElectronApplication, page: Page, factor = 1) {
  const block = factor < 1 ? 2 : 1;
  await page.evaluate((block) => {
    const canvas = document.querySelector("canvas")!,
      context = canvas.getContext("2d")!;
    const original = context.putImageData.bind(context);
    // One LCD pixel may occupy multiple pixels in the transport surface.
    const sourceBlockX = block * (canvas.width / 320);
    const sourceBlockY = block * (canvas.height / 240);
    const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4,
          v =
            (Math.floor(x / sourceBlockX) + Math.floor(y / sourceBlockY)) % 2
              ? 255
              : 0;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
        pixels[i + 3] = 255;
      }
    const pattern = new ImageData(pixels, canvas.width, canvas.height);
    context.putImageData = () => original(pattern, 0, 0);
    context.putImageData(pattern, 0, 0);
    const controls = document.querySelector(".clock-controls") as HTMLElement;
    const visibility = controls?.style.visibility;
    if (controls) controls.style.visibility = "hidden";
    (window as any).__restorePixelPattern = () => {
      context.putImageData = original;
      if (controls) controls.style.visibility = visibility;
    };
  }, block);
  try {
    const rect = await page.locator("canvas").evaluate((c) => {
      const r = c.getBoundingClientRect(),
        d = window.devicePixelRatio;
      return { x: Math.round(r.x * d), y: Math.round(r.y * d) };
    });
    const png = (await page.screenshot({ scale: "device" })).toString("base64");
    const checked = await app.evaluate(
      ({ nativeImage }, { png, rect, factor, block }) => {
        const im = nativeImage.createFromBuffer(Buffer.from(png, "base64")),
          width = im.getSize().width,
          bytes = im.toBitmap();
        let wrong = 0,
          first: any;
        for (let y = 0; y < 240 * factor; y++)
          for (let x = 0; x < 320 * factor; x++) {
            const i = ((rect.y + y) * width + rect.x + x) * 4,
              expected =
                (Math.floor(x / (factor * block)) +
                  Math.floor(y / (factor * block))) %
                2
                  ? 255
                  : 0;
            if (
              bytes[i] !== expected ||
              bytes[i + 1] !== expected ||
              bytes[i + 2] !== expected
            ) {
              wrong++;
              first ??= { x, y, value: Array.from(bytes.subarray(i, i + 4)) };
            }
          }
        return { wrong, first };
      },
      { png, rect, factor, block },
    );
    expect(checked).toEqual({ wrong: 0, first: undefined });
  } finally {
    await page.evaluate(() => (window as any).__restorePixelPattern());
  }
}

test("live chassis shows aggregate keyboard/pointer input, releases safely, and toggles without restarting", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-chassis-"));
  const { app, page, rpc, action } = await launch(root, "zelda");
  try {
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    const chassis = page.locator('[data-ui="chassis"]');
    await expect(chassis).toBeVisible();
    await expect(chassis).toHaveAttribute("data-model", "zelda");
    await aligned(page);
    await page.evaluate(() => {
      (window as any).__chassisEvents = [];
      for (const type of [
        "pointerdown",
        "pointerup",
        "pointercancel",
        "lostpointercapture",
        "gotpointercapture",
        "keydown",
        "keyup",
      ])
        document.addEventListener(
          type,
          (event: any) => {
            const list = (window as any).__chassisEvents;
            list.push({
              type: event.type,
              buttons: event.buttons,
              pointerId: event.pointerId,
              code: event.code,
              target: event.target?.dataset?.ui,
              trusted: event.isTrusted,
              time: performance.now(),
            });
            if (list.length > 100) list.shift();
          },
          true,
        );
    });
    const a = page.locator('[data-ui="chassis.button.a"]');
    const mask = async (value: number) => {
      try {
        await expect
          .poll(async () => (await rpc("app.getDiagnostics")).input)
          .toMatchObject({ desiredMask: value, appliedMask: value });
      } catch (error) {
        await test.info().attach("input-events", {
          body: JSON.stringify(
            {
              log: await rpc("logging.tail", { limit: 80, module: "input" }),
              dom: await page.evaluate(() => (window as any).__chassisEvents),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
        throw error;
      }
    };
    // SELECT/START stay game mappings even with a focused chassis control.
    await a.focus();
    await page.keyboard.down("Tab");
    await mask(2048);
    await expect(a).toBeFocused();
    await page.keyboard.down("Enter");
    await mask(3072);
    await page.keyboard.up("Tab");
    await mask(1024);
    await page.keyboard.up("Enter");
    await mask(0);
    // A lagging aggregate snapshot must not destroy local key ownership.
    await a.focus();
    await page.keyboard.down("Space");
    await mask(16);
    const previousInput = (await rpc("app.getDiagnostics")).input;
    await app.evaluate(
      ({ BrowserWindow }, input) =>
        BrowserWindow.getAllWindows()[0].webContents.send("input.state", input),
      { ...previousInput, desiredMask: 0, appliedMask: 0 },
    );
    await expect(a).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.up("Space");
    await mask(0);
    await page.locator("canvas").focus();
    await page.keyboard.down("Enter");
    await mask(1024);
    await page.keyboard.press("Tab");
    await page.keyboard.up("Enter");
    await mask(0);
    await action("ui.key", { key: "X", down: true });
    await mask(16);
    await expect(a).toHaveAttribute("aria-pressed", "true");
    await action("ui.pointer", { id: "chassis.button.a", phase: "down" });
    expect(
      await page.evaluate(
        () =>
          (window as any).__chassisEvents.findLast(
            (event: any) => event.type === "pointerdown",
          ).buttons,
      ),
    ).toBe(1);
    await action("ui.key", { key: "X", down: false });
    await mask(16);
    await action("ui.key", { key: "Left", down: true });
    await mask(17);
    await action("ui.pointer", { phase: "up", x: 2, y: 2 });
    await mask(1);
    await action("ui.key", { key: "Left", down: false });
    await mask(0);
    // Two touch pointers keep separate ownership, including the same button.
    await a.dispatchEvent("pointerdown", {
      pointerId: 10,
      pointerType: "touch",
      button: 0,
    });
    await a.dispatchEvent("pointerdown", {
      pointerId: 11,
      pointerType: "touch",
      button: 0,
    });
    await mask(16);
    await a.dispatchEvent("pointercancel", {
      pointerId: 10,
      pointerType: "touch",
    });
    await mask(16);
    await a.dispatchEvent("pointercancel", {
      pointerId: 11,
      pointerType: "touch",
    });
    await mask(0);
    // Exercise genuine Chromium touch capture/cancellation as well as fallback events.
    const cdp = await page.context().newCDPSession(page);
    const boxA = (await a.boundingBox())!,
      boxB = (await page
        .locator('[data-ui="chassis.button.b"]')
        .boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: boxA.x + boxA.width / 2, y: boxA.y + boxA.height / 2, id: 20 },
        { x: boxB.x + boxB.width / 2, y: boxB.y + boxB.height / 2, id: 21 },
      ],
    });
    await mask(48);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await mask(0);
    await cdp.detach();
    // Space remains available for explicitly focused accessible controls.
    await a.focus();
    await page.keyboard.down("Space");
    await mask(16);
    await page.locator("canvas").focus();
    await mask(0);
    await page.keyboard.up("Space");
    await action("ui.pointer", { id: "chassis.button.b", phase: "down" });
    await mask(32);
    await action("ui.menu", { id: "file.make" });
    await mask(0);
    await action("ui.click", { id: "rom.cancel" });
    await action("ui.pointer", { phase: "up", x: 2, y: 2 });
    await action("ui.pointer", { id: "chassis.button.a", phase: "down" });
    await mask(16);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await mask(0);
    await action("ui.pointer", { phase: "up", x: 2, y: 2 });
    const state = await rpc("app.getState");
    const before = await rpc("app.getDiagnostics");
    await action("ui.key", { key: "Left", down: true });
    await action("ui.pointer", { id: "chassis.button.a", phase: "down" });
    await mask(17);
    await action("ui.menu", { id: "view.chassis" });
    await mask(1);
    await expect(chassis).not.toBeVisible();
    expect((await rpc("app.getState")).runtimeSessionId).toBe(
      state.runtimeSessionId,
    );
    const menus = (await rpc("ui.inspect")).menus;
    expect(menus.find((m: any) => m.id === "view.chassis").checked).toBe(false);
    await rpc("ui.waitFor", {
      condition: "ui.lastPresented",
      value: String(Number(before.lastPresented) + 2),
    });
    await action("ui.pointer", { phase: "up", x: 2, y: 2 });
    await action("ui.key", { key: "Left", down: false });
    await mask(0);
    await action("ui.menu", { id: "view.chassis" });
    await expect(chassis).toBeVisible();
    await mkdir(resolve("../out/ui-validation"), { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await action("ui.key", { key: "Left", down: true });
      await action("ui.key", { key: "X", down: true });
      await mask(17);
      await page.screenshot({
        path: resolve(`../out/ui-validation/chassis-zelda-${theme}.png`),
      });
      await action("ui.key", { key: "Left", down: false });
      await action("ui.key", { key: "X", down: false });
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(380, 480),
    );
    await aligned(page);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1000, 620),
    );
    await aligned(page);
    // Load another actual model and reject delayed input tagged with the old runtime.
    await rpc("automation.queueDialogResponse", {
      kind: "open",
      path: resolve("../profiles/mario.gnw.json"),
    });
    await action("ui.menu", { id: "file.open" });
    await expect(chassis).toHaveAttribute("data-model", "mario");
    await aligned(page);
    await page.evaluate(
      (id) => window.desktop.button(4, true, "pointer:99", id),
      state.runtimeSessionId,
    );
    await mask(0);
    await expect(page.locator('[data-ui="chassis.button.start"]')).toHaveCount(
      0,
    );
    await expect
      .poll(
        () =>
          page.locator("canvas").evaluate((canvas: any) => {
            const bytes = canvas
              .getContext("2d")
              .getImageData(0, 0, 320, 240).data;
            let lit = 0;
            for (let i = 0; i < bytes.length; i += 4)
              if (bytes[i] + bytes[i + 1] + bytes[i + 2] > 30) lit++;
            return lit;
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(1000);
    await page.screenshot({
      path: resolve("../out/ui-validation/chassis-mario.png"),
    });
    await action("ui.menu", { id: "view.clock" });
    await actualPixels(page);
    await pixelPattern(app, page);
    await aligned(page);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("chassis preference survives restart and failed writes restore the checkbox", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "gnw-chassis-pref-"));
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch(root);
    expect(
      (await launched.rpc("ui.inspect")).menus.find(
        (m: any) => m.id === "view.clock",
      ).enabled,
    ).toBe(false);
    await launched.action("ui.menu", { id: "view.chassis" });
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8"))
        .showChassis,
    ).toBe(false);
    await launched.app.close();
    launched = undefined;
    launched = await launch(root, "mario");
    await launched.rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    await expect(
      launched.page.locator('[data-ui="chassis"]'),
    ).not.toBeVisible();
    // Force a real persistence failure without permission-dependent chmod behavior.
    await rename(join(root, "settings.json"), join(root, "settings.saved"));
    await mkdir(join(root, "settings.json"));
    await expect(
      launched.action("ui.menu", { id: "view.chassis" }),
    ).rejects.toThrow();
    const inspect = await launched.rpc("ui.inspect");
    expect(
      inspect.menus.find((m: any) => m.id === "view.chassis").checked,
    ).toBe(false);
    await expect(
      launched.page.locator('[data-ui="chassis"]'),
    ).not.toBeVisible();
    await rm(join(root, "settings.json"), { recursive: true });
    await rename(join(root, "settings.saved"), join(root, "settings.json"));
    await launched.action("ui.menu", { id: "view.chassis" });
    await expect(launched.page.locator('[data-ui="chassis"]')).toBeVisible();
  } finally {
    await launched?.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const model of ["zelda", "mario"]) {
  test(`${model} transport resolution preserves physical LCD size with and without chassis`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gnw-lcd-size-"));
    const { app, page, rpc, action } = await launch(root, model);
    try {
      await rpc("ui.waitFor", {
        condition: "app.status",
        value: "running",
        timeoutMs: 15000,
      });
      await rpc("ui.waitFor", { condition: "ui.lastPresented", value: "2" });
      const session = (await rpc("app.getState")).runtimeSessionId;
      expect(
        await page.locator("canvas").evaluate((c: HTMLCanvasElement) => ({
          width: c.width,
          height: c.height,
        })),
      ).toEqual({ width: 640, height: 480 });
      const size = () =>
        page.locator("canvas").evaluate((c) => {
          const r = c.getBoundingClientRect(),
            d = window.devicePixelRatio;
          return { width: r.width * d, height: r.height * d };
        });
      await expect.poll(size).toEqual({ width: 1280, height: 960 });
      for (const factor of [0.5, 1, 2, 3]) {
        await action("ui.menu", {
          id: `view.scale.${factor === 0.5 ? "half" : factor}`,
        });
        await expect
          .poll(size)
          .toEqual({ width: 320 * factor, height: 240 * factor });
        await aligned(page);
        await pixelPattern(app, page, factor);
        await action("ui.menu", { id: "view.chassis" });
        await expect(page.locator('[data-ui="chassis"]')).toHaveCount(0);
        await expect
          .poll(size)
          .toEqual({ width: 320 * factor, height: 240 * factor });
        await pixelPattern(app, page, factor);
        await action("ui.menu", { id: "view.chassis" });
        await expect
          .poll(size)
          .toEqual({ width: 320 * factor, height: 240 * factor });
      }
      expect((await rpc("app.getState")).runtimeSessionId).toBe(session);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const model of ["zelda", "mario"]) {
  test(`${model} pixel presets preserve LCD through frame toggles and restart clock preferences`, async () => {
    test.setTimeout(60000);
    const root = await mkdtemp(join(tmpdir(), "gnw-scales-"));
    let live = await launch(root, model);
    let liveProcess = live.app.process();
    const size = async () =>
      live.page.locator("canvas").evaluate((c) => {
        const r = c.getBoundingClientRect(),
          d = window.devicePixelRatio;
        return { width: r.width * d, height: r.height * d };
      });
    const preset = async (factor: number) => {
      await live.action("ui.menu", {
        id: `view.scale.${factor === 0.5 ? "half" : factor}`,
      });
      await expect
        .poll(size)
        .toEqual({ width: 320 * factor, height: 240 * factor });
    };
    const quit = async () => {
      const host = live.app.process();
      await live.rpc("ui.menu", { id: "app.quit" }).catch(() => {});
      await expect.poll(() => host.exitCode).toBe(0);
    };
    try {
      await live.rpc("ui.waitFor", {
        condition: "app.status",
        value: "running",
        timeoutMs: 15000,
      });
      await live.rpc("ui.waitFor", {
        condition: "ui.lastPresented",
        value: "2",
      });
      const session = await live.rpc("app.getState");
      // Exercise the gwemu 2× transport surface, not only an empty 320×240 canvas.
      expect(
        await live.page.locator("canvas").evaluate((c: HTMLCanvasElement) => ({
          width: c.width,
          height: c.height,
        })),
      ).toEqual({ width: 640, height: 480 });
      await preset(2);
      await aligned(live.page);
      expect(
        (await live.rpc("ui.inspect")).menus.find(
          (i: any) => i.id === "view.scale.2",
        ),
      ).toMatchObject({ type: "radio", checked: true });
      await pixelPattern(live.app, live.page, 2);
      const before = await live.rpc("ui.inspect");
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 640, height: 480 });
      expect((await live.rpc("ui.inspect")).window.bounds.width).toBeLessThan(
        before.window.bounds.width,
      );
      await preset(0.5);
      await pixelPattern(live.app, live.page, 0.5);
      await mkdir(resolve("../out/ui-validation"), { recursive: true });
      await live.page.screenshot({
        path: resolve(`../out/ui-validation/normal-half-${model}.png`),
      });
      for (const id of ["window.menu", "window.close"])
        expect(
          await live.page.locator(`[data-ui="${id}"]`).evaluate((e) => {
            const r = e.getBoundingClientRect();
            return r.x >= 0 && r.right <= innerWidth;
          }),
        ).toBe(true);
      // Maker uses a usable size without replacing the game preference.
      await live.action("ui.menu", { id: "file.make" });
      await expect(live.page.locator("dialog")).toBeVisible();
      await live.action("ui.click", { id: "rom.cancel" });
      await expect.poll(size).toEqual({ width: 160, height: 120 });
      await preset(3);
      const area = await live.app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows()[0],
          area = screen.getDisplayMatching(w.getBounds()).workArea;
        w.setBounds({ ...w.getBounds(), x: area.x, y: area.y });
        return area;
      });
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 960, height: 720 });
      expect(
        (await live.rpc("ui.inspect")).window.bounds.y,
      ).toBeGreaterThanOrEqual(area.y);
      await live.app.evaluate(({ BrowserWindow }, area) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setBounds({
          x: area.x,
          y: area.y,
          width: area.width + 120,
          height: area.height + 120,
        });
      }, area);
      await expect
        .poll(() =>
          live.page
            .locator('[data-ui="window.close"]')
            .evaluate((e) => e.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(area.width);
      await preset(3);
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 960, height: 720 });
      await live.action("ui.menu", { id: "view.clock" });
      await preset(0.5);
      await live.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(100, 75),
      );
      await expect.poll(size).toEqual({ width: 200, height: 150 });
      expect(
        (await live.rpc("ui.inspect")).menus
          .filter(
            (i: any) =>
              i.id?.startsWith("view.scale.") &&
              i.type === "radio" &&
              i.checked,
          )
          .map((i: any) => i.id),
      ).toEqual(["view.scale.custom"]);
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 200, height: 150 });
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 200, height: 150 });
      await preset(0.5);
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 160, height: 120 });
      await pixelPattern(live.app, live.page, 0.5);
      await live.page.screenshot({
        path: resolve(`../out/ui-validation/clock-half-${model}.png`),
      });
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 160, height: 120 });
      await live.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setBounds({ ...w.getBounds(), x: 120, y: 180 });
      });
      const placed = (await live.rpc("ui.inspect")).window.bounds;
      expect((await live.rpc("app.getState")).runtimeSessionId).toBe(
        session.runtimeSessionId,
      );
      await quit();
      const settings = JSON.parse(
        await readFile(join(root, "settings.json"), "utf8"),
      );
      expect(settings).toMatchObject({
        normalScale: 3,
        clockScale: 0.5,
        clockMode: true,
        showChassis: false,
        clockBounds: placed,
      });

      live = await launch(root, model);
      liveProcess = live.app.process();
      await expect(live.page.locator("main")).toHaveClass("desktop-clock", {
        timeout: 15000,
      });
      await expect.poll(size).toEqual({ width: 160, height: 120 });
      await expect
        .poll(async () => (await live.rpc("ui.inspect")).window.bounds)
        .toEqual(placed);
      await live.action("ui.menu", { id: "view.clock" });
      await expect.poll(size).toEqual({ width: 960, height: 720 });
      await live.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(300, 257),
      );
      await expect.poll(size).toEqual({ width: 600, height: 450 });
      await live.action("ui.menu", { id: "view.chassis" });
      await expect.poll(size).toEqual({ width: 600, height: 450 });
      await live.action("ui.menu", { id: "view.clock" });
      await expect.poll(size).toEqual({ width: 160, height: 120 });
      await quit();

      live = await launch(root);
      liveProcess = live.app.process();
      await expect(live.page.locator("main")).toHaveClass("normal-window");
      expect((await live.rpc("ui.inspect")).window.preferredClockMode).toBe(
        true,
      );
      if (model === "zelda") {
        await live.rpc("automation.queueDialogResponse", {
          kind: "open",
          path: join(root, "missing.gnw.json"),
        });
        await expect(
          live.action("ui.menu", { id: "file.open" }),
        ).rejects.toThrow();
        expect((await live.rpc("ui.inspect")).window.preferredClockMode).toBe(
          true,
        );
        expect(
          JSON.parse(await readFile(join(root, "settings.json"), "utf8"))
            .clockMode,
        ).toBe(true);
        await live.rpc("automation.queueDialogResponse", {
          kind: "open",
          path: resolve(`../profiles/${model}.gnw.json`),
        });
        await live.action("ui.menu", { id: "file.open" });
      } else {
        await live.action("ui.menu", { id: "file.make" });
        await expect(live.page.locator("dialog")).toBeVisible();
        await live.action("ui.click", { id: "rom.model.mario" });
        await live.action("ui.fill", {
          id: "rom.internalFlash",
          value: resolve("../../firmware/internal_flash_backup_mario.bin"),
        });
        await live.action("ui.fill", {
          id: "rom.externalFlash",
          value: resolve("../../firmware/flash_backup_mario.bin"),
        });
        await live.rpc("automation.queueDialogResponse", {
          kind: "save",
          path: join(root, "made.gnw.json"),
        });
        await live.action("ui.click", { id: "rom.saveAndLoad" });
      }
      await expect(live.page.locator("main")).toHaveClass("desktop-clock", {
        timeout: 15000,
      });
      await expect.poll(size).toEqual({ width: 160, height: 120 });
      await live.action("ui.menu", { id: "view.clock" });
      await expect.poll(size).toEqual({ width: 600, height: 450 });
      // Quit immediately after a final manual resize: do not wait for debounce.
      await live.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(333, 231),
      );
      const finalCanvas = (await live.rpc("ui.inspect")).canvas;
      const finalScale =
        (finalCanvas.displayWidth * finalCanvas.devicePixelRatio) / 320;
      await quit();
      const finalSettings = JSON.parse(
        await readFile(join(root, "settings.json"), "utf8"),
      );
      expect(finalSettings.normalScale).toBeCloseTo(finalScale, 3);
      expect(finalSettings).toMatchObject({
        clockScale: 0.5,
        clockMode: false,
        showChassis: true,
      });
    } finally {
      if (liveProcess.exitCode === null) await live.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("desktop clock preserves session and canvas, fits artwork, restores bounds and refuses unfocused input", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "gnw-clock-"));
  const { app, page, rpc, action } = await launch(root, "zelda");
  const hostProcess = app.process();
  try {
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    await rpc("ui.waitFor", { condition: "ui.lastPresented", value: "2" });
    const state = await rpc("app.getState");
    const before = await rpc("ui.inspect");
    const qemuPid = (await rpc("app.getDiagnostics")).qemuPid;
    await page.evaluate(
      () =>
        ((window as any).__originalCanvas = document.querySelector("canvas")),
    );
    const mask = async (value: number) => {
      await expect
        .poll(async () => (await rpc("app.getDiagnostics")).input)
        .toMatchObject({ desiredMask: value, appliedMask: value });
    };
    const tight = async () => {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const c = document
              .querySelector('[data-ui="chassis"]')!
              .getBoundingClientRect();
            const screen = document
              .querySelector(".game-screen")!
              .getBoundingClientRect();
            return Math.max(
              Math.abs(c.x - screen.x),
              Math.abs(c.y - screen.y),
              Math.abs(c.width - screen.width),
              Math.abs(c.height - screen.height),
            );
          }),
        )
        .toBeLessThan(2);
      await aligned(page);
    };
    await tight();
    await action("ui.key", { key: "X", down: true });
    await mask(16);
    await action("ui.menu", { id: "view.clock" });
    await mask(0);
    // Isolation quarantines held physical keys until their release.
    await action("ui.key", { key: "X", down: false });
    const compact = await rpc("ui.inspect");
    expect((await rpc("app.getDiagnostics")).qemuPid).toBe(qemuPid);
    expect(compact.menus.find((m: any) => m.id === "file.open").enabled).toBe(
      false,
    );
    expect(compact.window).toMatchObject({
      clockMode: true,
      alwaysOnTop: true,
    });
    await actualPixels(page);
    await pixelPattern(app, page);
    expect(compact.window.pixelPerfect).toBe(true);
    const density = await page.evaluate(() => window.devicePixelRatio);
    expect(compact.window.contentBounds.width).toBe(
      Math.ceil((950 * 320) / (416 * density)),
    );
    const zoom = compact.menus.find((m: any) => m.id === "window.zoom");
    if (zoom) expect(zoom.enabled).toBe(false);
    await expect(page.locator(".window-titlebar")).toBeHidden();
    await tight();
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(
          size.width,
          size.height,
        ),
      {
        width: Math.round(compact.window.contentBounds.width * 0.65),
        height: Math.round(compact.window.contentBounds.height * 0.65),
      },
    );
    await expect
      .poll(async () => (await rpc("ui.inspect")).window.pixelPerfect)
      .toBe(false);
    expect(
      (await rpc("ui.inspect")).canvas.displayWidth * density,
    ).toBeLessThan(320);
    await action("ui.menu", { id: "view.scale.1" });
    await actualPixels(page);

    expect((await rpc("app.getState")).runtimeSessionId).toBe(
      state.runtimeSessionId,
    );
    await rpc("ui.waitFor", {
      condition: "ui.lastPresented",
      value: String(Number(before.canvas.lastPresented) + 2),
    });
    await action("ui.key", { key: "Left", down: true });
    await mask(1);
    // Steal real native focus; renderer remains alive, so IPC must be refused by main.
    await app.evaluate(({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 200, height: 100 });
      (globalThis as any).__focusSink = other;
      other.show();
      other.focus();
    });
    await expect
      .poll(async () => (await rpc("ui.inspect")).window.focused)
      .toBe(false);
    await mask(0);
    await page.evaluate((id) => {
      window.desktop.key("KeyX", true);
      window.desktop.button(4, true, "pointer:99", id);
      window.desktop.key("ArrowLeft", false);
    }, state.runtimeSessionId);
    await page.evaluate(() => window.desktop.inputState());
    await mask(0);
    await app.evaluate(() => (globalThis as any).__focusSink.destroy());
    await action("ui.key", { key: "X", down: true });
    await mask(16);
    await action("ui.key", { key: "X", down: false });
    await mask(0);
    await mkdir(resolve("../out/ui-validation"), { recursive: true });
    // Wait for firmware boot, then explicitly select TIME for the review screenshot.
    const lit = () =>
      page.locator("canvas").evaluate((c: any) => {
        const pixels = c
          .getContext("2d")
          .getImageData(0, 0, c.width, c.height).data;
        let total = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) total++;
        return total;
      });
    await expect.poll(lit, { timeout: 15000 }).toBeGreaterThan(1000);
    await action("ui.key", { key: "T", down: true });
    await action("ui.key", { key: "T", down: false });
    await expect.poll(lit, { timeout: 15000 }).toBeGreaterThan(1000);
    await page.screenshot({
      path: resolve("../out/ui-validation/desktop-clock.png"),
    });
    await action("ui.click", { id: "window.normal" });
    const restored = await rpc("ui.inspect");
    expect((await rpc("app.getDiagnostics")).qemuPid).toBe(qemuPid);
    expect(restored.window).toMatchObject({
      clockMode: false,
      alwaysOnTop: before.window.alwaysOnTop,
      bounds: before.window.bounds,
    });
    expect((await rpc("app.getState")).runtimeSessionId).toBe(
      state.runtimeSessionId,
    );
    expect(
      await page.evaluate(
        () =>
          (window as any).__originalCanvas === document.querySelector("canvas"),
      ),
    ).toBe(true);
    await action("ui.menu", { id: "view.clock" });
    await action("ui.menu", { id: "view.chassis" });
    await expect(page.locator('[data-ui="chassis"]')).toBeHidden();
    await actualPixels(page);
    await pixelPattern(app, page);
    const plain = await rpc("ui.inspect");
    expect(plain.window.contentBounds).toMatchObject({
      width: Math.ceil(320 / density),
      height: Math.ceil(240 / density),
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(100, 75),
    );
    expect((await rpc("ui.inspect")).window.contentBounds.width).toBe(100);
    await expect
      .poll(() =>
        page
          .locator("canvas")
          .evaluate(
            (c) => c.getBoundingClientRect().width * window.devicePixelRatio,
          ),
      )
      .toBeLessThan(320);
    await action("ui.menu", { id: "view.scale.1" });
    await actualPixels(page);
    expect(
      plain.window.contentBounds.width / plain.window.contentBounds.height,
    ).toBeCloseTo(4 / 3, 2);
    await action("ui.menu", { id: "view.chassis" });
    await tight();
    await actualPixels(page);
    await action("ui.menu", { id: "view.clock" });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setAlwaysOnTop(true);
      w.maximize();
    });
    await expect
      .poll(async () => (await rpc("ui.inspect")).window.maximized)
      .toBe(true);
    expect({
      scale: (await rpc("ui.inspect")).window.normalScale,
      normalBounds: await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getNormalBounds(),
      ),
    }).toMatchObject({
      scale: before.window.normalScale,
      normalBounds: {
        width: before.window.bounds.width,
        height: before.window.bounds.height,
      },
    });
    await action("ui.menu", { id: "view.clock" });
    expect((await rpc("ui.inspect")).window).toMatchObject({
      maximized: false,
      clockMode: true,
    });
    await tight();
    await action("ui.menu", { id: "view.clock" });
    await expect
      .poll(async () => (await rpc("ui.inspect")).window.maximized)
      .toBe(true);
    expect((await rpc("ui.inspect")).window.alwaysOnTop).toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].unmaximize(),
    );
    await expect
      .poll(async () => (await rpc("ui.inspect")).window.maximized)
      .toBe(false);
    await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise<void>((resolve, reject) => {
          const w = BrowserWindow.getAllWindows()[0];
          const timer = setTimeout(
            () => reject(Error("Fullscreen entry timed out")),
            8000,
          );
          w.once("enter-full-screen", () => {
            clearTimeout(timer);
            resolve();
          });
          w.setFullScreen(true);
        }),
    );
    await action("ui.menu", { id: "view.clock" });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen(),
      ),
    ).toBe(false);
    await tight();
    await action("ui.menu", { id: "view.clock" });
    expect((await rpc("ui.inspect")).window.bounds).toEqual(
      before.window.bounds,
    );
    await action("ui.menu", { id: "view.clock" });
    await action("ui.click", { id: "window.close" }).catch(() => {});
    await expect.poll(() => hostProcess.exitCode).toBe(0);
  } finally {
    if (hostProcess.exitCode === null) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser mouse and keyboard share ownership and release independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-browser-input-"));
  const { app, page, rpc } = await launch(root, "zelda");
  try {
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    await rpc("ui.waitFor", {
      condition: "ui.lastPresented",
      value: "2",
      timeoutMs: 15000,
    });
    const box = (await page
      .locator('[data-ui="chassis.button.a"]')
      .boundingBox())!;
    const mask = (value: number) =>
      expect
        .poll(async () => (await rpc("app.getDiagnostics")).input)
        .toMatchObject({ desiredMask: value, appliedMask: value });
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await mask(16);
      await page.keyboard.down("ArrowLeft");
      await mask(17);
      await page.mouse.up();
      await mask(1);
      await page.keyboard.up("ArrowLeft");
      await mask(0);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
