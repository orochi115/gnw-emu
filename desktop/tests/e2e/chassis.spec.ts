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
    await page.evaluate(()=>{
      (window as any).__chassisEvents=[];
      for(const type of ["pointerdown","pointerup","pointercancel","lostpointercapture","gotpointercapture","keydown","keyup"])
        document.addEventListener(type,(event:any)=>{
          const list=(window as any).__chassisEvents;
          list.push({type:event.type,buttons:event.buttons,pointerId:event.pointerId,code:event.code,target:event.target?.dataset?.ui,trusted:event.isTrusted,time:performance.now()});
          if(list.length>100)list.shift();
        },true);
    });
    const a = page.locator('[data-ui="chassis.button.a"]');
    const mask = async (value: number) => {
      try {
        await expect
          .poll(async () => (await rpc("app.getDiagnostics")).input)
          .toMatchObject({ desiredMask: value, appliedMask: value });
      } catch (error) {
        await test
          .info()
          .attach("input-events", {
            body: JSON.stringify(
              {log:await rpc("logging.tail", { limit: 80, module: "input" }),dom:await page.evaluate(()=>(window as any).__chassisEvents)},
              null,
              2,
            ),
            contentType: "application/json",
          });
        throw error;
      }
    };
    // Enter the controls using only keyboard navigation, starting at the game.
    await page.locator("canvas").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-ui="chassis.button.left"]')).toBeFocused();
    await mask(0);
    await page.keyboard.down("Space");
    await mask(1);
    await page.keyboard.up("Space");
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
    expect(await page.evaluate(()=>(window as any).__chassisEvents.findLast((event:any)=>event.type==="pointerdown").buttons)).toBe(1);
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
    // Accessible long press uses button identity; Tab changes focus without START/SELECT.
    await a.focus();
    await page.keyboard.down("Space");
    await mask(16);
    await page.keyboard.press("Tab");
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
