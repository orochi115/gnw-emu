// Interactive Windows verification, usable for master or an extracted stock EXE.
import { _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const resultPath = resolve(
  process.env.GNW_CLOCK_RESULT ?? "../out/clock-refresh-result.json",
);
await mkdir(resolve("../out"), { recursive: true });
const data = await mkdtemp(join(tmpdir(), "gnw-clock-refresh-"));
const results = [];
let live;
const ui = async (action, args = {}) =>
  JSON.parse(
    (
      await exec(
        "python",
        [resolve("tools/windows-native-ui.py"), action, JSON.stringify(args)],
        { encoding: "utf8" },
      )
    ).stdout.trim(),
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function launch() {
  const exe = process.env.GNW_CLOCK_EXE;
  const args = [
    ...(!exe ? [resolve(".")] : []),
    "--language=en",
    `--user-data-dir=${data}`,
    ...(!exe ? [resolve("../profiles/zelda.gnw.json")] : []),
  ];
  const app = await electron.launch({
    ...(exe ? { executablePath: resolve(exe) } : {}),
    args,
    timeout: 60000,
  });
  live = app;
  const page = await app.firstWindow();
  await until(
    async () =>
      (await page.evaluate(() => window.desktop.state())).status === "running",
    "stock startup",
  );
  const state = () => page.evaluate(() => window.desktop.windowState());
  const info = () =>
    app.evaluate(({ BrowserWindow, screen, app }) => {
      const w = BrowserWindow.getAllWindows()[0],
        bounds = w.getBounds(),
        d = screen.getDisplayMatching(bounds);
      return {
        pid: process.pid,
        bounds,
        screen: d.bounds,
        work: d.workArea,
        density: d.scaleFactor,
        opacity: w.getOpacity(),
        topmost: w.isAlwaysOnTop(),
        physical: screen.dipToScreenRect(w, bounds),
        userData: app.getPath("userData"),
      };
    });
  const menu = async (id) => {
    await until(
      () =>
        app.evaluate(
          ({ Menu }, id) =>
            !!Menu.getApplicationMenu().getMenuItemById(id)?.enabled,
          id,
        ),
      `menu:${id}`,
    );
    await app.evaluate(
      ({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(),
      id,
    );
    await until(async () => !(await state()).transitioning, "menu transition");
  };
  const context = async (...labels) => {
    const n = await info();
    const canvas = await page.locator('[data-ui="game.canvas"]').boundingBox();
    await ui("click", {
      x: (n.bounds.x + canvas.x + canvas.width * 0.5) * n.density,
      y: (n.bounds.y + canvas.y + canvas.height * 0.5) * n.density,
      button: "right",
    });
    const menus = await ui("menus", { pid: n.pid });
    assert(menus.length);
    for (const label of labels) await ui("select", { pid: n.pid, label });
    return menus;
  };
  return { app, page, state, info, menu, context };
}
try {
  await ui("session");
  let test = await launch();
  await test.menu("view.clock");
  await until(async () => (await test.state()).clockMode, "clock entry");
  const menu = await test.context("Window opacity", "60%");
  await until(
    async () => Math.abs((await test.info()).opacity - 0.6) < 0.01,
    "native opacity",
  );
  assert.equal((await test.state()).clockOpacity, 0.6);
  const settingsPath = join(
    (await test.info()).userData,
    "..",
    "settings.json",
  );
  await until(
    async () =>
      JSON.parse(await readFile(settingsPath, "utf8")).clockOpacity === 0.6,
    "persisted opacity",
  );
  const canvasMask = await test.page.evaluate(
    () => document.querySelectorAll(".chassis-focus").length,
  );
  assert.equal(canvasMask, 0);
  assert(
    await test.page
      .locator(".chassis-button")
      .evaluateAll((buttons) => buttons.every((b) => b.tabIndex === -1)),
  );
  const button = test.page.locator('[data-ui="chassis.button.a"]');
  await button.click();
  assert(!(await button.evaluate((b) => document.activeElement === b)));
  await test.context("Dock", "Bottom Left");
  let n = await test.info();
  assert(Math.abs(n.bounds.x - n.screen.x) <= 1);
  assert(
    Math.abs(n.bounds.y + n.bounds.height - n.screen.y - n.screen.height) <= 1,
  );
  assert(n.topmost);
  const bar = await ui("taskbar");
  const overlap = {
    x: n.physical.x + n.physical.width / 2,
    y: Math.min(n.physical.y + n.physical.height - 5, bar.bounds[3] - 5),
  };
  assert(
    overlap.y >= bar.bounds[1] && overlap.y < bar.bounds[3],
    "Clock must actually overlap taskbar",
  );
  assert.equal(
    (await ui("hit-test", overlap)).pid,
    n.pid,
    "Taskbar covers clock",
  );
  await ui("move", {
    x: bar.bounds[0] + (bar.bounds[2] - bar.bounds[0]) * 0.75,
    y: bar.bounds[3] - 5,
  });
  await delay(500);
  assert.equal(
    (await ui("hit-test", overlap)).pid,
    n.pid,
    "Taskbar hover covers clock",
  );
  results.push({
    check:
      "native opacity persistence, flush screen docking and taskbar coverage including taskbar hover",
    passed: true,
    bounds: n.bounds,
    taskbar: bar,
    hit: overlap,
    opacityMenu: menu,
  });
  await test.context("Dock", "Top Left");
  await test.context("Pixel Scale", "0.5× (160 × 120)");
  await until(
    async () => (await test.state()).pixelScale === 0.5,
    "small scale",
  );
  const controls = await test.page.locator(".clock-controls").evaluate((e) => {
    const r = e.getBoundingClientRect(),
      button = e.querySelector("button").getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      buttonWidth: button.width,
    };
  });
  assert(controls.x <= 3 && controls.y <= 3);
  assert(controls.buttonWidth < 28);
  await test.context("Return to normal window");
  await until(async () => !(await test.state()).clockMode, "normal mode");
  assert.equal((await test.info()).opacity, 1);
  await test.menu("view.clock");
  await until(
    async () => Math.abs((await test.info()).opacity - 0.6) < 0.01,
    "opacity restored on toggle",
  );
  await test.app.close();
  live = undefined;
  test = await launch();
  await until(
    async () => (await test.state()).clockMode,
    "saved clock restart",
  );
  assert.equal((await test.state()).clockOpacity, 0.6);
  assert(Math.abs((await test.info()).opacity - 0.6) < 0.01);
  results.push({
    check:
      "top-left compact toolbar, chassis without focus activation, normal opacity and restart persistence",
    passed: true,
    controls,
  });
  await test.page.screenshot({
    path: resolve("../out/clock-refresh-small.png"),
  });
  await writeFile(
    resultPath,
    JSON.stringify({ passed: true, results }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, results }));
} catch (error) {
  await writeFile(
    resultPath,
    JSON.stringify(
      { passed: false, error: String(error), stack: error.stack, results },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await ui("escape").catch(() => {});
  await ui("escape").catch(() => {});
  await live?.close().catch(() => {});
}
