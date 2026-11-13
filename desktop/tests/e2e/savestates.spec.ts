import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

test("real hotkeys and native slots save/load with bottom toasts and survive relaunch", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "gnw-state-ui-"));
  const id = randomUUID();
  const profile = join(root, "stock.gnw.json");
  const data = join(root, "data");
  await writeFile(
    profile,
    JSON.stringify({
      formatVersion: 1,
      id,
      model: "zelda",
      internalFlash: resolve("../../firmware/internal_flash_backup_zelda.bin"),
      externalFlash: resolve("../../firmware/flash_backup_zelda.bin"),
    }),
  );
  const launch = () =>
    electron.launch({
      args: [
        resolve("."),
        "--language=zh-CN",
        `--user-data-dir=${data}`,
        profile,
      ],
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(() => window.desktop.state().then((s) => s.status)),
      )
      .toBe("running");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].focus(),
    );
    await page.keyboard.press("F5");
    await expect(
      page.getByRole("status").filter({ hasText: "已保存槽位 0" }),
    ).toBeVisible();
    const slot = join(data, "kernels", "gwemu", "sessions", id, "states-gwemu", "slot-0.json");
    const manifest = JSON.parse(await readFile(slot, "utf8"));
    expect(
      (
        await readFile(
          join(data, "kernels", "gwemu", "sessions", id, "states-gwemu", manifest.id, "state.bin"),
        )
      ).length,
    ).toBeGreaterThan(4 * 1024 * 1024);
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => {
          const menu = Menu.getApplicationMenu()!;
          return (
            menu.getMenuItemById("state.save")!.enabled &&
            menu.getMenuItemById("state.load")!.enabled &&
            menu
              .getMenuItemById("state.slot.0")!
              .label.includes(new Date().getFullYear().toString())
          );
        }),
      )
      .toBe(true);
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.getMenuItemById("state.slot.9")!.click(),
    );
    await expect(
      page.getByRole("status").filter({ hasText: "已选择即时存档槽位 9" }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.keyboard.press("F8");
    await expect(
      page.getByRole("alert").filter({ hasText: "槽位 9 为空" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭提示" }).click();
    await page.keyboard.press("F7");
    await expect(
      page.getByRole("status").filter({ hasText: "已选择即时存档槽位 0" }),
    ).toBeVisible();
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.getMenuItemById("state.load")!.click(),
    );
    await expect(
      page.getByRole("status").filter({ hasText: "已读取槽位 0" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.desktop.inputState().then((s) => s.appliedMask),
        ),
      )
      .toBe(0);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(() => window.desktop.state().then((s) => s.status)),
      )
      .toBe("running");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].focus(),
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.keyboard.press("F8");
    await expect(
      page.getByRole("status").filter({ hasText: "已读取槽位 0" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
