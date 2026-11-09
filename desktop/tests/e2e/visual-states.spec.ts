import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test("dark theme, narrow dialog, optional fields and recoverable errors remain usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-visual-"));
  const app = await electron.launch({
    args: [
      resolve("."),
      "--automation",
      "--test-dialogs",
      `--user-data-dir=${root}`,
    ],
  });
  const page = await app.firstWindow();
  try {
    await expect(page.getByText("尚未加载 ROM")).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await mkdir(resolve("../out/ui-validation"), { recursive: true });
    await page.screenshot({
      path: resolve("../out/ui-validation/dark-empty.png"),
    });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      Menu.getApplicationMenu()!.getMenuItemById("file.make")!.click();
      BrowserWindow.getAllWindows()[0].setContentSize(380, 480);
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByLabel("内部 Flash", { exact: true })
      .fill("/a very long directory/不存在的文件.bin");
    await page
      .getByLabel("外部 Flash", { exact: true })
      .fill(resolve("../../firmware/flash_backup_zelda.bin"));
    await page.getByText("高级选项", { exact: true }).click();
    await page.getByLabel("器件 UID", { exact: false }).fill("bad");
    await page.getByRole("button", { name: "保存…", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("器件 UID");
    await page.screenshot({
      path: resolve("../out/ui-validation/dark-narrow-error.png"),
    });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(640, 480);
      Menu.getApplicationMenu()!.getMenuItemById("file.make")!.click();
    });
    await page.getByLabel("内部 Flash", { exact: true }).fill("/missing.bin");
    await page.getByLabel("外部 Flash", { exact: true }).fill("/missing.bin");
    await expect
      .poll(async () => {
        try {
          return JSON.parse(
            await readFile(join(root, "automation.json"), "utf8"),
          ).url;
        } catch {
          return "";
        }
      })
      .not.toBe("");
    const ep = JSON.parse(
      await readFile(join(root, "automation.json"), "utf8"),
    );
    await fetch(ep.url, {
      method: "POST",
      headers: { authorization: `Bearer ${ep.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "automation.queueDialogResponse",
        params: { kind: "save", path: join(root, "bad.gnw.json") },
      }),
    });
    await page.getByRole("button", { name: "保存…", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "内部 Flash： 无法读取文件",
    );

    await expect(page.getByLabel("内部 Flash", { exact: true })).toBeFocused();
    await page.screenshot({
      path: resolve("../out/ui-validation/light-field-error.png"),
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
