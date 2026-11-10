import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("clock context controls dock and mute the existing game and persist on restart", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-clock-context-"));
  async function launch() {
    const app = await electron.launch({
      args: [
        resolve("."),
        "--automation",
        "--language=zh-CN",
        `--user-data-dir=${root}`,
        resolve("../profiles/zelda.gnw.json"),
      ],
    });
    const page = await app.firstWindow();
    let ep: any;
    await expect
      .poll(async () => {
        try {
          ep = JSON.parse(
            await readFile(join(root, "automation.json"), "utf8"),
          );
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    async function rpc(method: string, params: any = {}) {
      const response: any = await (
        await fetch(ep.url, {
          method: "POST",
          headers: { authorization: `Bearer ${ep.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();
      if (response.error) throw Error(JSON.stringify(response.error));
      return response.result;
    }
    async function action(method: string, id: string) {
      const start = await rpc(method, { id });
      let result: any;
      await expect
        .poll(
          async () => {
            result = await rpc("automation.getOperation", {
              operationId: start.operationId,
            });
            return result.status;
          },
          { timeout: 15000 },
        )
        .not.toBe("pending");
      if (result.error) throw Error(JSON.stringify(result.error));
    }
    await expect
      .poll(async () => (await rpc("app.getState")).status)
      .toBe("running");
    return { app, page, rpc, action };
  }
  let live: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    live = await launch();
    expect((await live.rpc("ui.inspect")).contextMenus).toEqual([]);
    await live.action("ui.menu", "view.clock");
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8")).clockMode,
    ).toBe(true);
    const runtime = (await live.rpc("app.getState")).runtimeSessionId;
    const pid = (await live.rpc("app.getDiagnostics")).qemuPid;
    const area = await live.app.evaluate(
      ({ BrowserWindow, screen }) =>
        screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds())
          .workArea,
    );
    // Failed disk persistence rolls back the already-applied live QMP mute.
    const settingsPath = join(root, "settings.json");
    const savedPath = join(root, "settings-saved.json");
    await rename(settingsPath, savedPath);
    await mkdir(settingsPath);
    try {
      await expect(
        live.action("ui.contextMenu", "audio.mute"),
      ).rejects.toThrow();
      expect(await live.rpc("app.getDiagnostics")).toMatchObject({
        audioMuted: false,
        audio: { muted: false },
        runtimeSessionId: runtime,
      });
      expect(
        (await live.rpc("ui.inspect")).contextMenus.find(
          (i: any) => i.id === "audio.mute",
        ).checked,
      ).toBe(false);
    } finally {
      await rm(settingsPath, { recursive: true });
      await rename(savedPath, settingsPath);
    }
    await live.action("ui.contextMenu", "clock.dock.bottomRight");
    let inspect = await live.rpc("ui.inspect");
    expect(inspect.window.clockDock).toBe("bottomRight");
    expect(
      inspect.contextMenus.find((i: any) => i.id === "clock.dock.bottomRight")
        .checked,
    ).toBe(true);
    const pinned = (bounds: any) => {
      expect(bounds.x + bounds.width).toBe(area.x + area.width - 12);
      expect(bounds.y + bounds.height).toBe(area.y + area.height - 12);
    };
    pinned(inspect.window.bounds);
    await live.action("ui.contextMenu", "view.scale.half");
    pinned((await live.rpc("ui.inspect")).window.bounds);
    await live.action("ui.contextMenu", "view.chassis");
    inspect = await live.rpc("ui.inspect");
    pinned(inspect.window.bounds);
    expect(inspect.canvas.pixelScale).toBeCloseTo(0.5, 5);
    expect(
      inspect.contextMenus.find((i: any) => i.id === "view.chassis").checked,
    ).toBe(false);
    await live.action("ui.contextMenu", "audio.mute");
    expect(await live.rpc("app.getDiagnostics")).toMatchObject({
      qemuPid: pid,
      runtimeSessionId: runtime,
      audioMuted: true,
      audio: { muted: true },
    });
    expect(
      (await live.rpc("ui.inspect")).contextMenus.find(
        (i: any) => i.id === "audio.mute",
      ).checked,
    ).toBe(true);
    await live.action("ui.contextMenu", "audio.mute");
    expect((await live.rpc("app.getDiagnostics")).audioMuted).toBe(false);
    await live.action("ui.contextMenu", "audio.mute");
    await live.app.close();
    const settings = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    );
    expect(settings).toMatchObject({
      audio: false,
      clockDock: "bottomRight",
      clockScale: 0.5,
      showChassis: false,
    });
    live = await launch();
    await expect
      .poll(async () => (await live!.rpc("ui.inspect")).window.clockMode)
      .toBe(true);
    inspect = await live.rpc("ui.inspect");
    expect(inspect.window.clockDock).toBe("bottomRight");
    pinned(inspect.window.bounds);
    expect((await live.rpc("app.getDiagnostics")).audioMuted).toBe(true);
    await live.action("ui.contextMenu", "audio.mute");
    expect((await live.rpc("app.getDiagnostics")).audioMuted).toBe(false);
    // A native drag cancels the saved dock preference while retaining the scale.
    await live.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const bounds = window.getBounds();
      window.setPosition(bounds.x - 40, bounds.y - 40);
    });
    await expect
      .poll(async () => (await live!.rpc("ui.inspect")).window.clockDock)
      .toBe("none");
    expect((await live.rpc("ui.inspect")).canvas.pixelScale).toBeCloseTo(
      0.5,
      5,
    );
    await live.app.close();
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8")),
    ).toMatchObject({ audio: true, clockDock: "none" });
  } finally {
    await live?.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
