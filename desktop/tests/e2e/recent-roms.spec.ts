import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

test("recent native menu persists successful loads and preserves a running game on missing files", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-recent-ui-"));
  const data = join(root, "data");
  const a = join(root, "a", "stock.gnw.json");
  const b = join(root, "b", "stock.gnw.json");
  for (const path of [a, b]) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 1,
        id: randomUUID(),
        model: "zelda",
        internalFlash: resolve(
          "../../firmware/internal_flash_backup_zelda.bin",
        ),
        externalFlash: resolve("../../firmware/flash_backup_zelda.bin"),
      }),
    );
  }
  async function launch(profile?: string) {
    const app = await electron.launch({
      args: [
        resolve("."),
        "--automation",
        "--test-dialogs",
        "--language=en",
        `--user-data-dir=${data}`,
        ...(profile ? [profile] : []),
      ],
    });
    const page = await app.firstWindow();
    let ep: any;
    await expect
      .poll(async () => {
        try {
          ep = JSON.parse(
            await readFile(join(data, "automation.json"), "utf8"),
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
    async function action(method: string, params: any) {
      const start = await rpc(method, params);
      let result: any;
      await expect
        .poll(
          async () => {
            result = await rpc("automation.getOperation", {
              operationId: start.operationId,
            });
            return result.status;
          },
          { timeout: 20000 },
        )
        .not.toBe("pending");
      return result;
    }
    const menus = async () => (await rpc("ui.inspect")).menus as any[];
    const history = async () =>
      JSON.parse(await readFile(join(data, "settings.json"), "utf8"))
        .recentRoms;
    return { app, page, rpc, action, menus, history };
  }
  let live: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    live = await launch(a);
    await expect.poll(live.history).toEqual([a]);
    expect((await live.menus()).some((i) => i.id === "view.actualSize")).toBe(
      false,
    );
    // Canceled open must not change history.
    await live.rpc("automation.queueDialogResponse", {
      kind: "open",
      path: null,
    });
    expect(
      (await live.action("ui.menu", { id: "file.open" })).error,
    ).toBeUndefined();
    expect(await live.history()).toEqual([a]);
    await live.rpc("automation.queueDialogResponse", { kind: "open", path: b });
    expect(
      (await live.action("ui.menu", { id: "file.open" })).error,
    ).toBeUndefined();
    expect(await live.history()).toEqual([b, a]);
    const recent = (await live.menus()).filter((i) =>
      /^file.recent.\d$/.test(i.id),
    );
    expect(recent.map((i) => i.label)).toEqual([
      `stock.gnw.json — ${join(root, "b")}`,
      `stock.gnw.json — ${join(root, "a")}`,
    ]);
    expect(
      (await live.action("ui.menu", { id: "file.recent.1" })).error,
    ).toBeUndefined();
    expect(await live.history()).toEqual([a, b]);
    const state = await live.rpc("app.getState");
    expect(state.profilePath).toBe(a);
    await rm(b);
    expect(
      (await live.action("ui.menu", { id: "file.recent.1" })).error,
    ).toBeTruthy();
    expect(await live.rpc("app.getState")).toMatchObject({
      status: "running",
      runtimeSessionId: state.runtimeSessionId,
    });
    expect(await live.history()).toEqual([a, b]);
    // Child actions must be disabled, too: automation cannot bypass the parent guard.
    await live.action("ui.menu", { id: "file.make" });
    await expect(live.page.getByRole("dialog")).toBeVisible();
    expect(
      (await live.menus()).find((i) => i.id === "file.recent.0").enabled,
    ).toBe(false);
    await live.page
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(live.page.getByRole("dialog")).not.toBeVisible();
    await live.action("ui.menu", { id: "view.clock" });
    expect(
      (await live.menus()).find((i) => i.id === "file.recent.clear").enabled,
    ).toBe(false);
    await live.action("ui.menu", { id: "view.clock" });
    await live.app.close();
    live = await launch();
    expect((await live.rpc("app.getState")).status).toBe("idle");
    expect(await live.history()).toEqual([a, b]);
    expect(
      (await live.action("ui.menu", { id: "file.recent.0" })).error,
    ).toBeUndefined();
    const running = await live.rpc("app.getState");
    expect(running.status).toBe("running");
    expect(
      (await live.action("ui.menu", { id: "file.recent.clear" })).error,
    ).toBeUndefined();
    expect(await live.history()).toEqual([]);
    expect(await live.rpc("app.getState")).toMatchObject({
      status: "running",
      runtimeSessionId: running.runtimeSessionId,
    });
    expect(
      (await live.menus()).find((i) => i.id === "file.recent").enabled,
    ).toBe(false);
    await live.app.close();
    live = await launch();
    expect(await live.history()).toEqual([]);
  } finally {
    await live?.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
