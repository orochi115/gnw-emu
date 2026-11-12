import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createProfile } from "../../src/core/profile-store";

test.skip(
  !existsSync(resolve("../build/gwemu-manager-ram/qemu-system-arm")),
  "Build gwemu-manager-ram first",
);
test("gwemu hotkeys and menu slots restore repeatedly, paused and off, and survive isolated relaunch", async ({}, testInfo) => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "gnw-gwemu-state-ui-"));
  const data = join(root, "data");
  const internal = Buffer.alloc(128 * 1024, 0xff);
  internal.writeUInt32LE(0x20020000, 0);
  internal.writeUInt32LE(0x08000009, 4);
  internal[8] = 0xfe;
  internal[9] = 0xe7;
  const external = Buffer.alloc(1024 * 1024, 0x37);
  await writeFile(join(root, "internal.bin"), internal);
  await writeFile(join(root, "external.bin"), external);
  const profile = await createProfile(join(root, "synthetic.gnw.json"), {
    model: "mario",
    internalFlash: join(root, "internal.bin"),
    externalFlash: join(root, "external.bin"),
  });
  const directory = join(data, "kernels", "gwemu", "sessions", profile.id);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const launch = async () => {
    app = await electron.launch({
      args: [
        resolve("."),
        "--language=zh-CN",
        `--user-data-dir=${data}`,
        profile.path,
      ],
      env: { ...process.env, GNW_KERNEL: "gwemu" },
    });
    const page = await app.firstWindow();
    await page.evaluate(() => {
      (window as any).__stateTrace = [];
      window.desktop.onToast((value: unknown) =>
        (window as any).__stateTrace.push({ toast: value }),
      );
      window.addEventListener("keydown", (e) =>
        (window as any).__stateTrace.push({
          key: e.code,
          focus: document.hasFocus(),
        }),
      );
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.desktop.state().then((s) => s.status)),
      )
      .toBe("running");
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isFocused(),
        ),
      )
      .toBe(true);
    const state = () => page.evaluate(() => window.desktop.state());
    const menu = async (id: string) =>
      app!.evaluate(
        ({ Menu }, item) =>
          Menu.getApplicationMenu()!.getMenuItemById(item)!.click(),
        id,
      );
    const execution = (value: string) =>
      expect.poll(async () => (await state()).execution).toBe(value);
    const operation = async () =>
      expect.poll(async () => (await state()).stateOperation).toBeUndefined();
    const loaded = () =>
      expect(
        page.getByRole("status").filter({ hasText: "已读取槽位 0" }),
      ).toBeVisible();
    return { page, state, menu, execution, operation, loaded };
  };
  try {
    let ui = await launch();
    expect((await ui.state()).canInstantState).toBe(true);
    await ui.page.keyboard.press("F5");
    await expect(
      ui.page.getByRole("status").filter({ hasText: "已保存槽位 0" }),
    ).toBeVisible();
    await ui.operation();
    const slot = JSON.parse(
      await readFile(join(directory, "states-gwemu", "slot-0.json"), "utf8"),
    );
    expect(slot).toMatchObject({ version: 2, kernel: "gwemu" });
    expect(slot.buildSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(directory, "states"))).toBe(false);
    expect(existsSync(join(data, "sessions"))).toBe(false);
    await expect
      .poll(() =>
        app!.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!
            .getMenuItemById("state.slot.0")!
            .label.includes(new Date().getFullYear().toString()),
        ),
      )
      .toBe(true);
    await writeFile(
      join(directory, "flash.bin"),
      Buffer.alloc(external.length, 0x88),
    );
    await ui.page.keyboard.press("F8");
    await ui.loaded();
    await ui.operation();
    expect(await readFile(join(directory, "flash.bin"))).toEqual(external);
    await ui.menu("state.load");
    await ui.operation();
    await ui.loaded();
    await ui.execution("running");
    await ui.menu("device.pause");
    await ui.execution("paused");
    await ui.page.keyboard.press("F8");
    await ui.loaded();
    await ui.operation();
    await ui.execution("paused");
    await ui.menu("state.slot.2");
    await ui.page.keyboard.press("F5");
    await expect(
      ui.page.getByRole("status").filter({ hasText: "已保存槽位 2" }),
    ).toBeVisible();
    await ui.operation();
    await ui.menu("device.batteryPresent");
    await ui.execution("unpowered");
    await ui.menu("state.slot.1");
    await ui.page.keyboard.press("F5");
    await expect(
      ui.page.getByRole("status").filter({ hasText: "已保存槽位 1" }),
    ).toBeVisible();
    await ui.operation();
    expect(existsSync(join(directory, "states-gwemu", "slot-1.json"))).toBe(
      true,
    );
    await ui.page.keyboard.press("KeyC");
    await ui.execution("paused");
    await ui.menu("device.resume");
    await ui.execution("running");
    await ui.page.keyboard.press("F8");
    await expect(
      ui.page.getByRole("status").filter({ hasText: "已读取槽位 1" }),
    ).toBeVisible();
    await ui.operation();
    await ui.execution("unpowered");
    await ui.menu("state.slot.0");
    await ui.page.keyboard.press("F8");
    await ui.loaded();
    await ui.operation();
    await ui.execution("paused");
    await app!.close();
    app = undefined;
    ui = await launch();
    await ui.page.keyboard.press("F8");
    await ui.loaded();
    await ui.operation();
    await ui.execution("running");
    expect(await readFile(join(directory, "flash.bin"))).toEqual(external);
  } catch (error) {
    if (app) {
      const page = await app.firstWindow();
      const diagnostic = {
        renderer: await page.evaluate(async () => ({
          events: (window as any).__stateTrace,
          state: await window.desktop.state(),
          epoch: await window.desktop.inputEpoch(),
          window: await window.desktop.windowState(),
        })),
        main: await app.evaluate(({ BrowserWindow }) => ({
          focused: BrowserWindow.getAllWindows()[0].isFocused(),
          contentsFocused:
            BrowserWindow.getAllWindows()[0].webContents.isFocused(),
        })),
      };
      await testInfo.attach("state-dispatch-diagnostic", {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: "application/json",
      });
    }
    throw error;
  } finally {
    await app?.close();
    expect(await readFile(profile.internalFlash)).toEqual(internal);
    expect(await readFile(profile.externalFlash)).toEqual(external);
    await rm(root, { recursive: true, force: true });
  }
});
