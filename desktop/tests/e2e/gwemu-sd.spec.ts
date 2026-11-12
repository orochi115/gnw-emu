import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync, createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createProfile } from "../../src/core/profile-store";

const localProfile = resolve(
  "../out/profiles/sd-full_20261104_1021-spi1.gnw.json",
);
test.skip(
  !existsSync(resolve("../build/gwemu-softspi/qemu-system-arm")) ||
    !existsSync(localProfile),
  "Local SD firmware and fixed gwemu build required",
);

test("software SPI SD profile runs in an isolated real desktop and closes cleanly", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-gwemu-sd-ui-"));
  const source = JSON.parse(await readFile(localProfile, "utf8"));
  const images = Object.fromEntries(
    ["internalFlash", "externalFlash", "bank2Flash", "sdCard"].map((key) => [
      key,
      resolve(dirname(localProfile), source[key]),
    ]),
  );
  const hash = async (path: string) => {
    const result = createHash("sha256");
    for await (const chunk of createReadStream(path)) result.update(chunk);
    return result.digest("hex");
  };
  const hashes = await Promise.all(Object.values(images).map(hash));
  const profile = await createProfile(join(root, "ospi.gnw.json"), {
    model: "zelda",
    ...images,
    sdWiring: "ospi",
  } as any);
  const app = await electron.launch({
    args: [
      resolve("."),
      "--language=zh-CN",
      "--automation",
      `--user-data-dir=${root}`,
      profile.path,
    ],
    env: { ...process.env, GNW_KERNEL: "gwemu" },
  });
  let closed = false;
  try {
    const page = await app.firstWindow();
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
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    };
    const key = async (key: string, down: boolean) => {
      const operation = await rpc("ui.key", { key, down });
      await expect
        .poll(async () => {
          const state = await rpc("automation.getOperation", {
            operationId: operation.operationId,
          });
          expect(state.error).toBeUndefined();
          return state.status;
        })
        .not.toBe("pending");
    };
    await rpc("ui.waitFor", {
      condition: "app.status",
      value: "running",
      timeoutMs: 20000,
    });
    await page.waitForTimeout(500);
    await key("Left", true);
    await key("G", true);
    await expect
      .poll(async () => (await rpc("app.getDiagnostics")).input.appliedMask)
      .toBe(129);
    await page.waitForTimeout(1000);
    await key("G", false);
    await key("Left", false);
    // Native acceptance checks exact mounted/type symbols; this verifies the GUI path.
    await page.waitForTimeout(5000);
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
    // Require the Retro-Go green header; lit pixels alone also accept OFW.
    await expect
      .poll(
        () =>
          page.locator("canvas").evaluate((canvas: any) => {
            const pixels = canvas
              .getContext("2d")
              .getImageData(0, 0, canvas.width, 60).data;
            let green = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (
                pixels[i + 1] > 20 &&
                pixels[i + 1] > pixels[i] * 1.3 &&
                pixels[i + 1] > pixels[i + 2] * 1.3
              )
                green++;
            return green;
          }),
        { timeout: 30000 },
      )
      .toBeGreaterThan(10000);
    const output = resolve("../out/gwemu-softspi-sd");
    await mkdir(output, { recursive: true });
    await rpc("ui.screenshot", { path: join(output, "ospi-desktop.png") });
    expect((await rpc("app.getState")).canInstantState).toBe(false);
    const pid = (await rpc("app.getDiagnostics")).qemuPid;
    await app.close();
    closed = true;
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(
      existsSync(
        join(root, "kernels", "gwemu", "sessions", profile.id, "sdcard.img"),
      ),
    ).toBe(true);
    expect(existsSync(join(root, "sessions"))).toBe(false);
    expect(await Promise.all(Object.values(images).map(hash))).toEqual(hashes);
  } finally {
    if (!closed) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
