// Run in interactive Windows Session 1. Only kills PIDs spawned by this test.
import { _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (v) return v;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
const root = await mkdtemp(join(tmpdir(), "gnw-resilience-"));
const data = join(root, "中文 数据 🎮");
await mkdir(data);
const exe = process.env.GNW_CLOCK_EXE;
const profile = resolve(
  process.env.GNW_TEST_PROFILE ?? "../profiles/windows-mario.gnw.json",
);
const output = resolve(
  process.env.GNW_CLOCK_RESULT ?? "../out/clock-resilience-result.json",
);
const ps = async (command) =>
  (
    await exec("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    })
  ).stdout.trim();
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
let live, ownedPid;
async function launch() {
  const app = await electron.launch({
    ...(exe ? { executablePath: resolve(exe) } : {}),
    args: [
      ...(!exe ? [resolve(".")] : []),
      "--language=en",
      "--automation",
      `--user-data-dir=${data}`,
      ...(!exe ? [profile] : []),
    ],
    timeout: 60000,
  });
  live = app;
  const page = await app.firstWindow();
  await until(
    async () =>
      (await page.evaluate(() => window.desktop.state())).status === "running",
    "running",
  );
  const endpoint = JSON.parse(
    await readFile(join(data, "automation.json"), "utf8"),
  );
  const rpc = async (method, params) => {
    const response = await (
      await fetch(endpoint.url, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json();
    if (response.error) throw Error(JSON.stringify(response.error));
    return response.result;
  };
  const hostPid = await app.evaluate(() => process.pid);
  const native = async () => (await rpc("app.getDiagnostics", {})).qemuPid;
  const state = () => page.evaluate(() => window.desktop.state());
  const windowState = () => page.evaluate(() => window.desktop.windowState());
  const menu = async (id) => {
    await until(
      () =>
        app.evaluate(
          ({ Menu }, id) =>
            Menu.getApplicationMenu().getMenuItemById(id)?.enabled,
          id,
        ),
      `menu ${id}`,
    );
    await app.evaluate(
      ({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(),
      id,
    );
  };
  return { app, page, state, windowState, native, hostPid, menu, rpc };
}
try {
  let t = await launch();
  ownedPid = await t.native();
  assert(ownedPid > 0);
  await t.menu("view.clock");
  await until(async () => (await t.windowState()).clockMode, "clock");
  assert.equal((await t.state()).devicePower.usbPower, true);
  await t.menu("view.scale.half");
  await until(
    async () => (await t.windowState()).clockScale === 0.5,
    "small clock scale",
  );
  const controls = t.page.locator(".clock-controls");
  const toolbar = await controls.boundingBox();
  const viewport =
    t.page.viewportSize() ??
    (await t.page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  assert(toolbar.width <= viewport.width);
  assert.equal(await controls.locator("button").count(), 3);
  // Dock across the taskbar and deliberately put the taskbar above the already-blurred clock.
  const action = await t.rpc("ui.contextMenu", {
    id: "clock.dock.bottomRight",
  });
  await until(
    async () =>
      (
        await t.rpc("automation.getOperation", {
          operationId: action.operationId,
        })
      ).status !== "pending",
    "dock operation",
  );
  const info = await t.app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      bounds: w.getBounds(),
      physical: screen.dipToScreenRect(w, w.getBounds()),
      hwnd: w.getNativeWindowHandle().readBigUInt64LE().toString(),
    };
  });
  await ui("taskbar-raise", {});
  await delay(300); // first blur repair has finished
  await ui("taskbar-raise", { activate: false });
  await delay(2300);
  const b = info.physical;
  const hit = await ui("hit-test", {
    x: b.x + b.width * 0.5,
    y: b.y + b.height - 15,
  });
  assert.equal(hit.pid, t.hostPid);
  const after = await t.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  assert.deepEqual(after, info.bounds);
  results.push({ case: "already-blurred-taskbar-repair", hit, bounds: after });
  await controls.locator('[data-ui="window.minimize"]').click({ force: true });
  await delay(2400);
  assert(
    await t.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized(),
    ),
  );
  assert.equal((await t.state()).devicePower.usbPower, true);
  assert.equal((await t.windowState()).clockMode, true);
  await t.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].restore(),
  );
  // Returning to ordinary mode restores manual USB control.
  await t.page.evaluate(() => window.desktop.windowAction("normal"));
  await t.menu("device.usb");
  await until(
    async () => !(await t.state()).devicePower.usbPower,
    "manual USB disconnect",
  );
  await t.menu("state.save");
  await until(
    async () => (await t.state()).stateSlots?.[0],
    "USB-off snapshot save",
  );
  await t.menu("view.clock");
  await until(async () => (await t.windowState()).clockMode, "clock reentry");
  await t.menu("state.load");
  await until(async () => !(await t.state()).stateOperation, "snapshot load");
  assert.equal((await t.state()).devicePower.usbPower, true);
  results.push({ case: "clock-minimize-and-manual-usb-policy", toolbar });
  await ps(`Stop-Process -Id ${ownedPid} -Force`);
  const old = ownedPid;
  await until(async () => {
    const state = await t.state();
    const pid = await t.native();
    if (state.status === "running" && pid && pid !== old) {
      ownedPid = pid;
      return true;
    }
  }, "native automatic restart");
  await until(
    async () => (await t.windowState()).clockMode,
    "clock restored after restart",
  );
  assert.equal((await t.state()).devicePower.usbPower, true);
  results.push({
    case: "native-fault-recovery",
    oldPid: old,
    newPid: ownedPid,
  });
  // Wait for the actual WinAPI memory sample and inspect persisted diagnostics.
  await delay(62000);
  const logs = async () => {
    const files = await readdir(join(data, "logs"));
    return (
      await Promise.all(
        files
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => readFile(join(data, "logs", f), "utf8")),
      )
    )
      .join("\n")
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  };
  const records = await logs();
  assert(records.some((x) => x.event === "recovery.succeeded"));
  const memory = records.find(
    (x) => x.event === "memory.sample" && x.privateBytes > 0,
  );
  assert(memory?.systemCommitLimitBytes > 0);
  assert(memory?.handleCount > 0);
  results.push({ case: "persisted-memory-and-recovery-log", memory });
  await t.app.close();
  live = undefined;
  assert.equal(
    await ps(
      `Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
    ),
    "",
  );
  t = await launch();
  ownedPid = await t.native();
  await until(
    async () => (await t.windowState()).clockMode,
    "preferred clock launch",
  );
  assert.equal((await t.state()).devicePower.usbPower, true);
  const parent = t.hostPid;
  await ps(`Stop-Process -Id ${parent} -Force`);
  live = undefined;
  await until(
    async () =>
      !(await ps(
        `Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
      )),
    "job cleanup after forced UI termination",
  );
  results.push({
    case: "normal-and-forced-UI-exit-cleanup",
    hostPid: parent,
    nativePid: ownedPid,
  });
  await writeFile(output, JSON.stringify({ ok: true, data, results }, null, 2));
} catch (error) {
  await writeFile(
    output,
    JSON.stringify({ ok: false, data, results, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await live?.close().catch(() => {});
}
