import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
test("RPC operates real form, saves, loads pixels, preserves game on invalid ROM and releases keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-rpc-ui-"));
  const target = join(root, "制作 游戏.gnw.json");
  const internal = resolve("../../firmware/internal_flash_backup_zelda.bin"),
    external = resolve("../../firmware/flash_backup_zelda.bin");
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const before = await hash(external);
  const app = await electron.launch({
    args: [
      resolve("."),
      "--language=zh-CN",
      "--automation",
      "--test-dialogs",
      `--user-data-dir=${root}`,
    ],
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error("renderer:", error.message));
  try {
    await expect(page.getByText("尚未加载 ROM")).toBeVisible();
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
      const reply = (await (
        await fetch(endpoint.url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json()) as any;
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    };
    const action = async (method: string, params: any) => {
      const result = await rpc(method, params);
      let final: any;
      await expect
        .poll(
          async () => {
            final = await rpc("automation.getOperation", {
              operationId: result.operationId,
            });
            return final.status;
          },
          { timeout: 20000 },
        )
        .not.toBe("pending");
      expect(final.error, JSON.stringify(final)).toBeUndefined();
      return final.result;
    };
    await mkdir(resolve("../out/ui-validation"), { recursive: true });
    await rpc("ui.screenshot", {
      path: resolve("../out/ui-validation/empty.png"),
    });
    await action("ui.menu", { id: "file.make" });
    await expect(page.getByRole("dialog")).toBeVisible();
    await action("ui.fill", { id: "rom.internalFlash", value: internal });
    await action("ui.fill", { id: "rom.externalFlash", value: external });
    await expect(page.getByLabel("内部 Flash", { exact: true })).toHaveValue(
      internal,
    );
    await rpc("ui.screenshot", {
      path: resolve("../out/ui-validation/maker.png"),
    });
    await rpc("automation.queueDialogResponse", { kind: "save", path: null });
    await action("ui.click", { id: "rom.save" });
    await expect(
      page.getByRole("button", { name: "保存…", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("dialog")).toBeVisible();
    await rpc("automation.queueDialogResponse", { kind: "save", path: target });
    await action("ui.click", { id: "rom.saveAndLoad" });
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 15000,
    });
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8"))
        .recentRoms,
    ).toEqual([target]);
    await rpc("ui.waitFor", { condition: "ui.lastPresented", value: "2" });
    const diagnostics = await rpc("app.getDiagnostics");
    expect(diagnostics.width).toBe(320);
    expect(diagnostics.height).toBe(240);
    expect(Number(diagnostics.frames)).toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          page.locator("canvas").evaluate((canvas: any) => {
            const pixels = canvas
              .getContext("2d")
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let lit = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++;
            return lit;
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(1000);
    await rpc("ui.screenshot", {
      path: resolve("../out/ui-validation/game.png"),
    });
    const state = await rpc("app.getState");
    await action("ui.key", { key: "Left", down: true });
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).buttons)
      .toBe(1);
    await action("ui.menu", { id: "file.make" });
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).buttons)
      .toBe(0);
    await action("ui.click", { id: "rom.cancel" });
    const invalid = join(root, "invalid.gnw.json");
    await writeFile(invalid, "{}");
    await rpc("automation.queueDialogResponse", {
      kind: "open",
      path: invalid,
    });
    const operation = await rpc("ui.menu", { id: "file.open" });
    await expect
      .poll(
        async () =>
          (
            await rpc("automation.getOperation", {
              operationId: operation.operationId,
            })
          ).status,
      )
      .toBe("failed");
    expect((await rpc("app.getState")).runtimeSessionId).toBe(
      state.runtimeSessionId,
    );
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8"))
        .recentRoms,
    ).toEqual([target]);
    expect(await hash(external)).toBe(before);
    await writeFile(
      resolve("../out/ui-validation/diagnostics.json"),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
