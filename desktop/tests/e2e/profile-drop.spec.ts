import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createProfile, loadProfile } from "../../src/core/profile-store";

async function dropFiles(page: Page, files: string[]) {
  const session = await page.context().newCDPSession(page);
  const bounds = await page.locator('[data-ui="app"]').boundingBox();
  if (!bounds) throw new Error("Main window is missing");
  const data = { items: [], files, dragOperationsMask: 1 };
  try {
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await session.send("Input.dispatchDragEvent", {
        type,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        data,
      });
    }
  } finally {
    await session.detach();
  }
}

test("native file drop loads a relative profile and invalid drops preserve the game", async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), "gnw-drop-"));
  const firmware = process.env.GNW_TEST_FIRMWARE ?? resolve("../../firmware");
  const internal = join(firmware, "internal_flash_backup_zelda.bin");
  const external = join(firmware, "flash_backup_zelda.bin");
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const before = [await hash(internal), await hash(external)];
  const profile = process.env.GNW_DROP_PROFILE
    ? await loadProfile(process.env.GNW_DROP_PROFILE)
    : await createProfile(join(root, "测试 游戏.gnw.json"), {
        model: "zelda",
        internalFlash: internal,
        externalFlash: external,
      });
  const invalid = join(root, "invalid.gnw.json");
  await writeFile(invalid, "{}");
  const packaged = process.env.GNW_WINDOWS_PACKAGED;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [
      ...(packaged ? [] : [resolve(".")]),
      "--language=en",
      `--user-data-dir=${join(root, "UserData")}`,
    ],
    env: { ...process.env, GNW_KERNEL: "gwemu" },
  });
  try {
    const page = await app.firstWindow();
    const originalUrl = page.url();
    await expect(page.locator('[data-ui="app"]')).toHaveAttribute(
      "data-status",
      "idle",
    );
    await dropFiles(page, [profile.path]);
    await expect(page.locator('[data-ui="app"]')).toHaveAttribute(
      "data-status",
      "running",
      { timeout: 30000 },
    );
    const state = await page.evaluate(() => window.desktop.state());
    expect(state.profilePath).toBe(profile.path);
    expect(state.model).toBe("zelda");
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(root, "UserData/settings.json"), "utf8"),
          ).recentRoms,
      )
      .toEqual([profile.path]);
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
        { timeout: 30000 },
      )
      .toBeGreaterThan(20000);

    await dropFiles(page, [invalid]);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(
      (await page.evaluate(() => window.desktop.state())).runtimeSessionId,
    ).toBe(state.runtimeSessionId);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await dropFiles(page, [internal]);
    await expect(page.getByRole("alert")).toContainText(".gnw.json");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await dropFiles(page, [profile.path, invalid]);
    await expect(page.getByRole("alert")).toContainText("one");
    expect(
      (await page.evaluate(() => window.desktop.state())).runtimeSessionId,
    ).toBe(state.runtimeSessionId);
    expect(page.url()).toBe(originalUrl);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page.evaluate(() => window.desktop.makeRom());
    await expect(page.getByRole("dialog")).toBeVisible();
    await dropFiles(page, [profile.path]);
    await expect(page.getByRole("alert")).toContainText("Another operation");
    expect(
      (await page.evaluate(() => window.desktop.state())).runtimeSessionId,
    ).toBe(state.runtimeSessionId);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await dropFiles(page, [profile.path]);
    await expect
      .poll(
        async () => {
          const current = await page.evaluate(() => window.desktop.state());
          return (
            current.status === "running" &&
            current.runtimeSessionId !== state.runtimeSessionId
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    expect(
      JSON.parse(await readFile(join(root, "UserData/settings.json"), "utf8"))
        .recentRoms,
    ).toEqual([profile.path]);
    expect([await hash(internal), await hash(external)]).toEqual(before);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
