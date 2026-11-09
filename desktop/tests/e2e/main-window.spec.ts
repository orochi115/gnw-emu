import { test, expect, _electron as electron } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
test("native menu opens real maker controls and save cancellation preserves form", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-ui-"));
  const app = await electron.launch({
    args: [
      resolve("."),
      "--automation",
      "--test-dialogs",
      `--user-data-dir=${root}`,
    ],
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("尚未加载 ROM")).toBeVisible();
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById("file.make")!;
      item.click();
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存并加载…", exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel("内部 Flash", { exact: true })
      .fill(resolve("../../firmware/internal_flash_backup_zelda.bin"));
    await page
      .getByLabel("外部 Flash", { exact: true })
      .fill(resolve("../../firmware/flash_backup_zelda.bin"));
    await expect(
      page.getByRole("button", { name: "保存并加载…", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
