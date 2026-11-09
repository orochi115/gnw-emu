import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
test("English menus and segmented model controls retain real keyboard and SD behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-language-"));
  const app = await electron.launch({
    args: [
      resolve("."),
      "--language=en",
      "--automation",
      `--user-data-dir=${root}`,
    ],
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("No ROM loaded")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const menus = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.items.map((i) => ({
        id: i.id,
        label: i.label,
      })),
    );
    expect(menus.find((i) => i.id === "menu.edit")?.label).toBe("Edit");
    expect(menus.find((i) => i.id === "menu.window")?.label).toBe("Window");
    await page.locator('[data-ui="app.make"]').click();
    await expect(page.getByRole("radiogroup", { name: "Model" })).toBeVisible();
    const zelda = page.getByRole("radio", { name: "Zelda", exact: true });
    const mario = page.getByRole("radio", { name: "Mario", exact: true });
    await zelda.focus();
    await page.keyboard.press("ArrowRight");
    await expect(mario).toBeChecked();
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
      (await (
        await fetch(endpoint.url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json()) as any;
    const action = await rpc("ui.click", { id: "rom.model.zelda" });
    await expect
      .poll(
        async () =>
          (
            await rpc("automation.getOperation", {
              operationId: action.result.operationId,
            })
          ).result.status,
      )
      .toBe("succeeded");
    await expect(zelda).toBeChecked();
    const snapshot = (await rpc("ui.inspect")).result;
    expect(snapshot.locale).toBe("en");
    expect(
      snapshot.controls.find((c: any) => c.id === "rom.model.zelda").checked,
    ).toBe(true);
    const invalidFill = await rpc("ui.fill", {
      id: "rom.model.zelda",
      value: "bad",
    });
    await expect
      .poll(
        async () =>
          (
            await rpc("automation.getOperation", {
              operationId: invalidFill.result.operationId,
            })
          ).result.status,
      )
      .toBe("failed");
    await expect(zelda).toBeChecked();
    await expect(page.locator('[data-ui="rom.deviceUid"]')).toHaveCount(0);
    const wiring = page.locator('[data-ui="rom.sdWiring"]');
    await expect(wiring).toBeVisible();
    await expect(wiring).toBeDisabled();
    await page.locator('[data-ui="rom.sdCard"]').fill("/tmp/card.img");
    await expect(wiring).toBeEnabled();
    await wiring.selectOption("ospi");
    await expect(wiring).toHaveValue("ospi");
    await mkdir(resolve("../out/ui-validation"), { recursive: true });
    await page.screenshot({
      path: resolve("../out/ui-validation/english-maker.png"),
    });
    await page.locator('[data-ui="rom.cancel"]').click();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
