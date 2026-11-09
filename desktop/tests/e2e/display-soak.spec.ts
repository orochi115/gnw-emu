import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
test("ten minute real Electron/QEMU display queues and memory stay bounded", async () => {
  test.skip(
    process.env.GNW_SOAK !== "1",
    "Explicit ten-minute performance run",
  );
  test.setTimeout(660000);
  const root = await mkdtemp(join(tmpdir(), "gnw-soak-"));
  const profile = join(root, "game.gnw.json");
  await writeFile(
    profile,
    JSON.stringify({
      formatVersion: 1,
      id: randomUUID(),
      model: "zelda",
      internalFlash: resolve("../../firmware/internal_flash_backup_zelda.bin"),
      externalFlash: resolve("../../firmware/flash_backup_zelda.bin"),
    }),
  );
  const app = await electron.launch({
    args: [resolve("."), "--automation", `--user-data-dir=${root}`, profile],
  });
  const page = await app.firstWindow();
  try {
    await expect(page.locator("main")).toHaveAttribute(
      "data-status",
      "running",
      { timeout: 15000 },
    );
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
    const rpc = async (method: string, params: any = {}) =>
      (
        (await (
          await fetch(endpoint.url, {
            method: "POST",
            headers: { authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json()) as any
      ).result;
    // Navigate into a game using real keyboard input before sampling.
    await page.waitForTimeout(3000);
    await page.keyboard.press("g", { delay: 150 });
    await page.waitForTimeout(1000);
    await page.keyboard.press("x", { delay: 150 });
    const samples: any[] = [];
    for (let seconds = 0; seconds <= 600; seconds += 10) {
      const stats = await rpc("app.getDiagnostics");
      samples.push({ seconds, ...stats });
      expect(stats.queued ?? 0).toBeLessThanOrEqual(2);
      if (seconds % 60 === 0)
        console.log(
          `soak ${seconds}s frames=${stats.frames} RSS=${Math.round(stats.memory.rss / 1024 / 1024)}MiB`,
        );
      if (seconds < 600) await page.waitForTimeout(10000);
    }
    const first = samples[1],
      last = samples.at(-1);
    expect(last.memory.rss - first.memory.rss).toBeLessThan(80 * 1024 * 1024);
    await mkdir(resolve("../out/ui-validation"), { recursive: true });
    await writeFile(
      resolve("../out/ui-validation/soak.json"),
      JSON.stringify(samples, null, 2),
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
