// Run from an unlocked Windows Session 1. Uses real mouse/menu input.
import { _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  readdir,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
if (process.platform !== "win32") throw Error("Windows Session 1 is required");
const exec = promisify(execFile),
  r = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  results = [];
const profile = resolve(
  process.env.GNW_TEST_PROFILE ?? join(r, "profiles/zelda.gnw.json"),
);
const packageDir = resolve(
  process.env.GNW_TEST_PACKAGE_DIR ?? join(r, "desktop/release/win-unpacked"),
);
const version = JSON.parse(
  await readFile(join(r, "desktop/package.json"), "utf8"),
).version;
const portableZip = resolve(
  process.env.GNW_TEST_PORTABLE_ZIP ??
    join(r, `desktop/release/portable/gnw-emu-${version}-win-x64-portable.zip`),
);
const userSettings = join(
  process.env.APPDATA,
  "gnw-emu-desktop/UserData/settings.json",
);
const settingsHash = async () => {
  try {
    return createHash("sha256")
      .update(await readFile(userSettings))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const userHash = await settingsHash();
await mkdir(join(r, "out"), { recursive: true });
const ui = async (action, args = {}) =>
  JSON.parse(
    (
      await exec(
        "python",
        [
          join(r, "desktop/tools/windows-native-ui.py"),
          action,
          JSON.stringify(args),
        ],
        { encoding: "utf8" },
      )
    ).stdout.trim(),
  );
await ui("session");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw Error(description);
}
async function launch(exe, args = []) {
  const app = await electron.launch({
    executablePath: exe,
    args: ["--language=en", ...args, profile],
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-ui="app"]')?.dataset.status === "running",
      {},
      { timeout: 60000 },
    );
    await delay(1500);
    const state = () => page.evaluate(() => window.desktop.windowState());
    const native = async () => {
      const info = await app.evaluate(({ BrowserWindow, screen, app }) => {
        const w = BrowserWindow.getAllWindows()[0],
          bounds = w.getBounds(),
          d = screen.getDisplayMatching(bounds);
        return {
          pid: process.pid,
          hwnd: w.getNativeWindowHandle().readBigUInt64LE().toString(),
          bounds,
          contentSize: w.getContentSize(),
          workArea: d.workArea,
          density: d.scaleFactor,
          maximized: w.isMaximized(),
          maximizable: w.isMaximizable(),
          fullscreenable: w.isFullScreenable(),
          userData: app.getPath("userData"),
        };
      });
      return { ...info, physical: await ui("window", { hwnd: info.hwnd }) };
    };
    const openTop = async (id, label) => {
      const n = await native();
      const item = page.locator(`[data-ui="${id}"]`);
      const expanded = await item.isVisible();
      const button = expanded ? item : page.locator('[data-ui="window.menu"]');
      const b = await button.boundingBox();
      await ui("click", {
        x: (n.bounds.x + b.x + b.width / 2) * n.density,
        y: (n.bounds.y + b.y + b.height / 2) * n.density,
      });
      if (!expanded) await ui("select", { pid: n.pid, label });
      return n;
    };
    const command = async (id) => {
      assert.equal(id, "view.clock");
      const n = await openTop("menu.view", "View");
      await ui("select", { pid: n.pid, label: "Desktop Clock Mode" });
    };
    const canvasPoint = async () => {
      const n = await native(),
        b = await page.locator('[data-ui="game.canvas"]').boundingBox();
      return {
        x: Math.round((n.bounds.x + b.x + b.width / 2) * n.density),
        y: Math.round((n.bounds.y + b.y + b.height / 2) * n.density),
      };
    };
    const context = async () => {
      const n = await native();
      await ui("click", { ...(await canvasPoint()), button: "right" });
      const menus = await ui("menus", { pid: n.pid });
      assert.ok(menus.length, "No real Win32 menu");
      assert.ok(
        menus.some(
          (m) =>
            m.className === "#32768" &&
            m.items.some((x) => x.label === "Return to normal window"),
        ),
        JSON.stringify(menus),
      );
      assert.ok(
        menus.every((m) =>
          m.items.every((i) => !["Device", "Instant State"].includes(i.label)),
        ),
      );
      return { pid: n.pid, menus };
    };
    return { app, page, state, native, command, canvasPoint, context, openTop };
  } catch (error) {
    await ui("escape");
    await ui("escape");
    await app.close();
    throw error;
  }
}
const root = await mkdtemp(join(tmpdir(), "gnw-clock-fixed-"));
let live;
try {
  live = await launch(join(packageDir, "gnw-emu.exe"), [
    `--user-data-dir=${root}`,
  ]);
  await live.page.waitForSelector(".window-menubar:not(.collapsed)");
  assert.equal(await live.page.locator('[data-ui="window.menu"]').count(), 0);
  // Shrinking must collapse the bar, and widening must restore it.
  for (const [factor, expanded] of [
    [0.5, false],
    [3, true],
  ]) {
    await live.app.evaluate(
      ({ Menu }, factor) =>
        Menu.getApplicationMenu()
          .getMenuItemById(factor === 0.5 ? "view.scale.half" : "view.scale.3")
          .click(),
      factor,
    );
    await until(
      async () =>
        (await live.state()).pixelScale === factor &&
        !(await live.state()).transitioning,
      "scale",
    );
    await live.page.waitForSelector(
      expanded ? ".window-menubar:not(.collapsed)" : '[data-ui="window.menu"]',
    );
    const n = await live.openTop("menu.file", "File");
    const menus = await ui("menus", { pid: n.pid });
    assert.ok(
      menus.some(
        (m) =>
          m.className === "#32768" &&
          m.items.some((i) => i.label.split("\t")[0] === "Load ROM…"),
      ),
      JSON.stringify(menus),
    );
    await ui("escape");
    await ui("escape");
    await live.page.screenshot({path:join(r,`out/windows-menu-layout-${factor}.png`)});
    results.push({ case: "normal-menu-layout", factor, expanded, menus });
  }
  await live.command("view.clock");
  await live.page.waitForSelector(".windows-clock");
  await until(
    async () => !(await live.state()).transitioning,
    "Clock transition",
  );
  assert.equal((await live.native()).maximizable, false);
  await ui("move", { x: 2200, y: 200 });
  await delay(200);
  assert.equal(
    await live.page
      .locator(".clock-controls")
      .evaluate((e) => getComputedStyle(e).opacity),
    "0",
  );
  await ui("click", { ...(await live.canvasPoint()), clicks: 2 });
  await delay(300);
  assert.equal((await live.native()).maximized, false);
  await live.page.keyboard.down("ArrowUp");
  await live.page.waitForFunction(
    () =>
      Number(document.querySelector('[data-ui="app"]').dataset.desiredMask) > 0,
  );
  const held = await live.page.evaluate(() => window.desktop.inputState());
  await live.context();
  await ui("key-up", { key: 0x26 });
  await ui("escape");
  await ui("escape");
  await until(
    async () =>
      (await live.page.evaluate(() => window.desktop.inputState()))
        .appliedMask === 0,
    "Menu releases held input",
  );
  await ui("key-down", { key: 0x26 });
  await until(
    async () =>
      (await live.page.evaluate(() => window.desktop.inputState()))
        .appliedMask === held.appliedMask,
    "Keyboard rearmed after menu",
  );
  await ui("key-up", { key: 0x26 });
  await live.page.keyboard.up("ArrowUp");
  const opened = await live.context();
  results.push({ case: "native-clock-menu", menus: opened.menus });
  const frame = opened.menus
    .flatMap((m) => m.items)
    .find((x) => x.label === "Show Device Frame");
  assert.ok(frame.checked);
  await ui("select", { pid: opened.pid, label: "Show Device Frame" });
  await until(
    async () =>
      !(await live.page.evaluate(() => window.desktop.preferences()))
        .showChassis,
    "Frame toggle",
  );
  assert.equal((await live.state()).pixelScale, 1);
  await live.context();
  await ui("select", { pid: opened.pid, label: "Dock" });
  await ui("select", { pid: opened.pid, label: "Bottom Right" });
  await until(
    async () => (await live.state()).clockDock === "bottomRight",
    "Native docking",
  );
  let n = await live.native();
  assert.ok(
    Math.abs(
      n.bounds.x + n.bounds.width - (n.workArea.x + n.workArea.width - 12),
    ) <= 1,
  );
  assert.ok(
    Math.abs(
      n.bounds.y + n.bounds.height - (n.workArea.y + n.workArea.height - 12),
    ) <= 1,
  );
  const initialSize = { width: n.bounds.width, height: n.bounds.height };
  const initialContent = n.contentSize;
  const initialPhysical = n.physical;
  for (let i = 0; i < 6; i++) {
    const point = await live.canvasPoint();
    await ui("drag", {
      start: [point.x, point.y],
      end: [point.x + (i % 2 ? 60 : -60), point.y + (i % 2 ? -30 : 30)],
    });
    await delay(200);
    const after = await live.native();
    assert.deepEqual(
      after.physical.bounds.slice(2),
      initialPhysical.bounds.slice(2),
      "Dragging changed physical window size",
    );
    assert.deepEqual(
      after.physical.client,
      initialPhysical.client,
      "Dragging changed physical client size",
    );
    // DIP enclosing rectangles can round differently when the physical origin moves at 150% DPI.
    for (const key of ["width", "height"])
      assert.ok(
        Math.abs(after.bounds[key] - initialSize[key]) <= 1,
        "Accumulated DIP size change",
      );
  }
  results.push({
    case: "repeated-drag-size",
    initialSize,
    initialContent,
    initialPhysical,
    after: await live.native(),
  });
  n = await live.native();
  const start = await live.canvasPoint();
  const target = {
    x: Math.round((n.workArea.x + 4 + n.bounds.width / 2) * n.density),
    y: Math.round((n.workArea.y + 420 + n.bounds.height / 2) * n.density),
  };
  await ui("drag", { start: [start.x, start.y], end: [target.x, target.y] });
  await until(
    async () => (await live.state()).clockDock === "left",
    "Magnetic left edge",
  );
  n = await live.native();
  assert.deepEqual(
    n.physical.bounds.slice(2),
    initialPhysical.bounds.slice(2),
    "Docking changed physical window size",
  );
  assert.deepEqual(
    n.physical.client,
    initialPhysical.client,
    "Docking changed physical client size",
  );
  assert.ok(Math.abs(n.bounds.x - (n.workArea.x + 12)) <= 1);
  assert.equal((await live.state()).pixelScale, 1);
  await live.page.screenshot({ path: join(r, "out/windows-clock-fixed.png") });
  const b = await live.page.locator('[data-ui="window.normal"]').boundingBox();
  await ui("move", {
    x: (n.bounds.x + b.x + b.width / 2) * n.density,
    y: (n.bounds.y + b.y + b.height / 2) * n.density,
  });
  await delay(250);
  assert.equal(
    await live.page
      .locator(".clock-controls")
      .evaluate((e) => getComputedStyle(e).opacity),
    "1",
  );
  await ui("click", {
    x: (n.bounds.x + b.x + b.width / 2) * n.density,
    y: (n.bounds.y + b.y + b.height / 2) * n.density,
  });
  await until(
    async () => !(await live.state()).clockMode,
    "Toolbar return button",
  );
  assert.equal((await live.native()).maximizable, true);
  n = await live.openTop("menu.settings", "Settings");
  const mainMenu = await ui("menus", { pid: n.pid });
  assert.ok(
    mainMenu.some((m) =>
      m.items.some((x) => x.label.split("\t")[0] === "Button Mapping…"),
    ),
  );
  results.push({ case: "native-main-menu", menus: mainMenu });
  await ui("select", { pid: n.pid, label: "Button Mapping…" });
  await until(
    async () => (await live.app.windows()).length === 2,
    "Controls menu callback",
  );
  await live.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .slice(1)
      .forEach((w) => w.close()),
  );
  results.push({
    case: "clock-interaction",
    passed: true,
    state: await live.state(),
    native: await live.native(),
  });
} finally {
  await writeFile(
    join(r, "out/windows-clock-portable-partial.json"),
    JSON.stringify(results, null, 2),
  );
  await ui("escape");
  await ui("escape");
  if (live) await live.app.close();
  live = undefined;
}
// Extracted portable ZIP: data is beside the executable and survives a move.
const portableRoot = await mkdtemp(join(tmpdir(), "gnw-portable-acceptance-"));
let portable = join(portableRoot, "portable initial");
const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
const extract = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${psQuote(portableZip)} -DestinationPath ${psQuote(portable)}`;
await exec("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(extract, "utf16le").toString("base64"),
]);
try {
  live = await launch(join(portable, "gnw-emu.exe"));
  assert.equal(
    (await live.native()).userData.replaceAll("\\", "/"),
    join(portable, "UserData/electron-host").replaceAll("\\", "/"),
  );
  await live.command("view.clock");
  await live.page.waitForSelector(".windows-clock");
  await until(
    async () => !(await live.state()).transitioning,
    "Portable clock",
  );
  const c = await live.context();
  await ui("select", { pid: c.pid, label: "Dock" });
  await ui("select", { pid: c.pid, label: "Left Edge" });
  await until(
    async () => (await live.state()).clockDock === "left",
    "Portable dock",
  );
} finally {
  await writeFile(
    join(r, "out/windows-clock-portable-partial.json"),
    JSON.stringify(results, null, 2),
  );
  await ui("escape");
  await ui("escape");
  if (live) await live.app.close();
  live = undefined;
}
const saved = JSON.parse(
  await readFile(join(portable, "UserData/settings.json"), "utf8"),
);
assert.equal(saved.clockMode, true);
assert.equal(saved.clockDock, "left");
const moved = join(portableRoot, "portable moved");
await rename(portable, moved);
portable = moved;
try {
  live = await launch(join(portable, "gnw-emu.exe"));
  await live.page.waitForSelector(".windows-clock");
  await until(
    async () => !(await live.state()).transitioning,
    "Restored clock",
  );
  assert.equal((await live.state()).clockDock, "left");
  assert.equal(
    (await live.native()).userData.replaceAll("\\", "/"),
    join(portable, "UserData/electron-host").replaceAll("\\", "/"),
  );
  results.push({
    case: "portable-move-restart",
    passed: true,
    state: await live.state(),
    native: await live.native(),
    dataFiles: await readdir(join(portable, "UserData")),
  });
} finally {
  if (live) await live.app.close();
  live = undefined;
}
const portableSettings = await readFile(
  join(portable, "UserData/settings.json"),
);
const override = await mkdtemp(join(tmpdir(), "gnw-portable-override-"));
try {
  live = await launch(join(portable, "gnw-emu.exe"), [
    `--user-data-dir=${override}`,
  ]);
  assert.equal(
    (await live.native()).userData.replaceAll("\\", "/"),
    join(override, "electron-host").replaceAll("\\", "/"),
  );
  assert.equal((await live.state()).clockMode, false);
  results.push({
    case: "portable-explicit-override",
    passed: true,
    native: await live.native(),
  });
} finally {
  if (live) await live.app.close();
  live = undefined;
}
assert.deepEqual(
  await readFile(join(portable, "UserData/settings.json")),
  portableSettings,
);
assert.equal(await settingsHash(), userHash);
await writeFile(
  join(r, "out/windows-clock-portable-result.json"),
  JSON.stringify({ passed: true, results }, null, 2),
);
console.log(
  JSON.stringify({ passed: true, cases: results.map((x) => x.case) }),
);
