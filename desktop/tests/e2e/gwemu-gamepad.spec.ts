import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { closeOwnedApplication } from "./helpers/owned-processes";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProfile } from "../../src/core/profile-store";
import { loadSettings, updateSettings } from "../../src/core/settings-store";

const binary = resolve("../build/gwemu-manager-ram/qemu-system-arm");
test.skip(!existsSync(binary), "Build the fixed gwemu desktop kernel first");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = async (p: string) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pad = (index = 0, pressed: number[] = [], axes = [0, 0]) => ({
  index,
  id: "Migration test controller",
  mapping: "standard",
  connected: true,
  axes,
  buttons: Array.from({ length: 16 }, (_, i) => ({
    pressed: pressed.includes(i),
    value: pressed.includes(i) ? 1 : 0,
  })),
});
type Pad = ReturnType<typeof pad>;

async function acceptance(
  model: "mario" | "zelda",
  run: (ui: any) => Promise<void>,
) {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), "gnw-gwemu-pad-"));
  const sources = ["mario", "zelda"].flatMap((m) => [
    resolve(`../../firmware/internal_flash_backup_${m}.bin`),
    resolve(`../../firmware/flash_backup_${m}.bin`),
  ]);
  const initial = await Promise.all(sources.map(hash));
  const parent = resolve("../out/gwemu-gamepad/electron");
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, `${model}-`));
  const evidence: any = {
    model,
    sourcePaths: sources,
    sourceBefore: initial,
    events: [],
    softwareGamepad: true,
  };
  const pids = new Set<number>();
  let app: ElectronApplication | undefined;
  let failurePage: Page | undefined;
  try {
    const manifest = JSON.parse(
      await readFile(
        resolve("../build/gwemu-manager-ram/gnw-build-manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.sourceDirty).toBe(false);
    evidence.binarySha256 = await hash(binary);
    expect(evidence.binarySha256).toBe(manifest.artifact.sha256);
    const profiles: any = {};
    for (const m of ["mario", "zelda"] as const)
      profiles[m] = await createProfile(join(root, `${m}.gnw.json`), {
        model: m,
        internalFlash: sources[m === "mario" ? 0 : 2],
        externalFlash: sources[m === "mario" ? 1 : 3],
      });
    const settings = await loadSettings(root);
    for (const [target, indexes] of [
      ["audio.mute", [4, 5]],
      ["device.usb", [6, 7]],
    ] as const)
      settings.controls.bindings.push({
        id: `pad-${target}`,
        target,
        modifiers: [],
        turbo: null,
        inputs: indexes.map((index) => ({
          kind: "gamepad" as const,
          device: "standard",
          control: "button" as const,
          index,
        })),
      });
    await updateSettings(root, { audio: false, controls: settings.controls });
    app = await electron.launch({
      args: [
        resolve("."),
        "--automation",
        "--test-dialogs",
        "--language=zh-CN",
        `--user-data-dir=${root}`,
        profiles[model].path,
      ],
      env: { ...process.env, GNW_KERNEL: "gwemu" },
    });
    const page = await app.firstWindow();
    failurePage = page;
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
      if (result.error) throw Error(JSON.stringify(result.error));
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
    };
    const state = () => rpc("app.getState");
    const identify = async () => {
      const d = await rpc("app.getDiagnostics");
      expect(d.qemuPid).toBeGreaterThan(0);
      expect(d.qemuPid).not.toBe(16603);
      pids.add(d.qemuPid);
      evidence.events.push({
        event: "identity",
        pid: d.qemuPid,
        session: d.runtimeSessionId,
      });
      return d;
    };
    await expect
      .poll(async () => (await state()).status, { timeout: 20000 })
      .toBe("running");
    await identify();
    const mainWindow = await app.browserWindow(page);
    const focus = async () => {
      await app!.evaluate(({ app }) => app.focus({ steal: true }));
      await mainWindow.evaluate((w) => w.focus());
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(true);
      await expect
        .poll(() => mainWindow.evaluate((w) => w.isFocused()))
        .toBe(true);
    };
    await focus();
    evidence.physicalGamepads = await page.evaluate(() =>
      Array.from(navigator.getGamepads())
        .filter(Boolean)
        .map((p) => p!.id),
    );
    await page.evaluate(() => {
      (window as any).__padReads = 0;
      (window as any).__pads = [];
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => {
          (window as any).__padReads++;
          return (window as any).__pads;
        },
      });
    });
    const reads = () =>
      page.evaluate(() => (window as any).__padReads as number);
    const snapshot = async (pads: Pad[], consume = true) => {
      const before = await reads();
      await page.evaluate((pads) => {
        (window as any).__pads = pads;
      }, pads);
      if (consume) await expect.poll(reads).toBeGreaterThanOrEqual(before + 2);
      evidence.events.push({
        event: "snapshot",
        pads,
        consumed: consume,
        reads: await reads(),
      });
    };
    const mask = async (value: number, active = true) => {
      await expect
        .poll(async () => (await rpc("app.getDiagnostics")).input)
        .toMatchObject({ desiredMask: value, appliedMask: value });
      const before = await reads();
      if (value === 0) {
        const end = Date.now() + 250;
        do {
          expect((await rpc("app.getDiagnostics")).input).toMatchObject({
            desiredMask: 0,
            appliedMask: 0,
          });
          await delay(20);
        } while (Date.now() < end);
        if (active) expect(await reads()).toBeGreaterThan(before);
      }
      evidence.events.push({ event: "mask", value, reads: await reads() });
    };
    await run({
      app,
      page,
      snapshot,
      mask,
      focus,
      rpc,
      action,
      state,
      identify,
      profiles,
      menu: (id: string) => action("ui.menu", { id }),
      execution: (value: string) =>
        expect.poll(async () => (await state()).execution).toBe(value),
    });
    await page.screenshot({ path: join(output, "desktop.png") });
    evidence.passed = true;
  } catch (error) {
    evidence.failure = String(error);
    try {
      await failurePage?.screenshot({
        path: join(output, "failure.png"),
        timeout: 1500,
      });
    } catch (captureError) {
      evidence.captureError = String(captureError);
    }
    throw error;
  } finally {
    const errors: unknown[] = [];
    try {
      if (app)
        await closeOwnedApplication(
          {
            pid: app.process().pid!,
            close: () => app!.close(),
            nativePids: pids,
          },
          evidence,
        );
    } catch (error) {
      errors.push(error);
    }
    try {
      evidence.sourceAfter = await Promise.all(sources.map(hash));
      expect(evidence.sourceAfter).toEqual(initial);
    } catch (error) {
      errors.push(error);
    }
    try {
      evidence.cleanupErrors = errors.map(String);
      await writeFile(
        join(output, "acceptance.json"),
        JSON.stringify(evidence, null, 2),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    if (errors.length)
      throw new AggregateError(errors, "Gamepad cleanup/audit failed");
  }
}

for (const model of ["mario", "zelda"] as const)
  test(`${model} Gamepad API mappings, axes, aggregation and reconnect reach gwemu`, async () => {
    await acceptance(model, async (ui) => {
      await ui.snapshot([pad()]);
      await ui.mask(0);
      for (const [index, value] of [
        [14, 1],
        [12, 2],
        [15, 4],
        [13, 8],
        [0, 16],
        [1, 32],
        [9, 1024],
        [8, 2048],
      ]) {
        await ui.snapshot([pad(0, [index])]);
        await ui.mask(value);
        await ui.snapshot([pad()]);
        await ui.mask(0);
      }
      for (const [axes, value] of [
        [[-0.7, 0], 1],
        [[0.7, 0], 4],
        [[0, -0.7], 2],
        [[0, 0.7], 8],
      ] as const) {
        await ui.snapshot([pad(0, [], [...axes])]);
        await ui.mask(value);
        await ui.snapshot([pad()]);
        await ui.mask(0);
      }
      await ui.snapshot([pad(0, [], [0.26, 0])]);
      await ui.mask(4);
      await ui.snapshot([pad(0, [], [0.22, 0])]);
      await ui.mask(4);
      await ui.snapshot([pad(0, [], [0.19, 0])]);
      await ui.mask(0);
      await ui.snapshot([pad(0, [0])]);
      await ui.mask(16);
      await ui.page.keyboard.down("x");
      await ui.snapshot([pad()]);
      await ui.mask(16);
      await ui.page.keyboard.up("x");
      await ui.mask(0);
      await ui.snapshot([pad(), pad(1)]);
      await ui.snapshot([pad(0, [0]), pad(1, [0])]);
      await ui.mask(16);
      await ui.snapshot([pad(), pad(1, [0])]);
      await ui.mask(16);
      await ui.snapshot([pad(), pad(1)]);
      await ui.mask(0);
      await ui.snapshot([pad(0, [0])]);
      await ui.mask(16);
      await ui.snapshot([]);
      await ui.mask(0);
      await ui.snapshot([pad(0, [0])]);
      await ui.mask(0);
      await ui.snapshot([pad()]);
      await ui.snapshot([pad(0, [0])]);
      await ui.mask(16);
      await ui.snapshot([pad()]);
      await ui.mask(0);
    });
  });

test("gwemu pad chords, focus, modal, pause, power and ROM boundaries release held inputs", async () => {
  await acceptance("zelda", async (ui) => {
    await ui.snapshot([pad(), pad(1)]);
    const muted = (await ui.rpc("app.getDiagnostics")).audioMuted;
    await ui.snapshot([pad(0, [4]), pad(1, [5])]);
    await ui.mask(0);
    expect((await ui.rpc("app.getDiagnostics")).audioMuted).toBe(muted);
    await ui.snapshot([pad(0, [4, 5]), pad(1, [5])]);
    await expect
      .poll(async () => (await ui.rpc("app.getDiagnostics")).audioMuted)
      .toBe(!muted);
    await ui.snapshot([pad()]);
    await ui.mask(0);
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(16);
    const probeId = await ui.app.evaluate(async ({ BrowserWindow }: any) => {
      const probe = new BrowserWindow({ width: 200, height: 100, show: true });
      await probe.loadURL("about:blank");
      probe.focus();
      return probe.id;
    });
    const mainWindow = await ui.app.browserWindow(ui.page);
    await expect
      .poll(() => mainWindow.evaluate((w: any) => w.isFocused()))
      .toBe(false);
    await expect
      .poll(() =>
        ui.page.evaluate(() =>
          window.desktop.windowState().then((s) => s.focused),
        ),
      )
      .toBe(false);
    await ui.mask(0, false);
    await ui.app.evaluate(
      ({ BrowserWindow }: any, id: number) => BrowserWindow.fromId(id)?.close(),
      probeId,
    );
    await ui.focus();
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(0);
    await ui.snapshot([pad()]);
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(16);
    const opened = ui.app.waitForEvent("window");
    await ui.page.evaluate(() => window.desktop.openControls("buttons"));
    const settings: Page = await opened;
    await expect(settings.locator('[data-ui="controls.dialog"]')).toBeVisible();
    await ui.mask(0, false);
    await settings.locator('[data-ui="controls.cancel"]').click();
    await ui.focus();
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(0);
    await ui.snapshot([pad()]);
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(16);
    await ui.menu("device.pause");
    await ui.execution("paused");
    await ui.mask(0);
    await ui.menu("device.resume");
    await ui.execution("running");
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(0);
    await ui.snapshot([pad()]);
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(16);
    await ui.menu("device.batteryPresent");
    await ui.execution("unpowered");
    await ui.mask(0);
    await ui.snapshot([pad(0, [0, 6, 7])]);
    await ui.execution("paused");
    await ui.mask(0);
    await ui.snapshot([pad(0, [0])]);
    await ui.menu("device.resume");
    await ui.execution("running");
    await ui.mask(0);
    await ui.snapshot([pad()]);
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(16);
    const old = await ui.identify();
    await ui.rpc("automation.queueDialogResponse", {
      kind: "open",
      path: ui.profiles.mario.path,
    });
    await ui.menu("file.open");
    await expect
      .poll(async () => (await ui.state()).runtimeSessionId)
      .not.toBe(old.runtimeSessionId);
    await expect.poll(async () => (await ui.state()).status).toBe("running");
    const next = await ui.identify();
    expect(next.qemuPid).not.toBe(old.qemuPid);
    expect(alive(old.qemuPid)).toBe(false);
    await ui.focus();
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(0);
    await ui.snapshot([pad()]);
    await ui.snapshot([pad(0, [0])]);
    await ui.mask(16);
    await ui.snapshot([pad()]);
    await ui.mask(0);
  });
});
