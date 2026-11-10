import { expect, test } from "vitest";
import { menuTemplate } from "../../src/main/menu";
import { initializeLocale } from "../../src/shared/locale";

test("control settings are reachable and configured shortcuts replace native defaults", () => {
  initializeLocale("en");
  const actions = {
    open() {},
    make() {},
    openControls() {},
    openHotkeys() {},
    controlAccelerators: { "file.open": "Shift+F8", "file.make": undefined },
  };
  const menu: any[] = menuTemplate("darwin", actions);
  const file = menu.find((m) => m.id === "menu.file").submenu;
  expect(file.find((m: any) => m.id === "file.open").accelerator).toBe(
    "Shift+F8",
  );
  expect(file.find((m: any) => m.id === "file.open").registerAccelerator).toBe(
    false,
  );
  expect(
    file.find((m: any) => m.id === "file.make").accelerator,
  ).toBeUndefined();
  const edit = menu.find((m) => m.id === "menu.edit").submenu;
  expect(edit.find((m: any) => m.id === "controls.open")).toBeUndefined();
  const settings = menu.find((m) => m.id === "menu.settings").submenu;
  expect(settings.map((m: any) => m.id)).toEqual([
    "controls.open",
    "controls.hotkeys",
  ]);
});
