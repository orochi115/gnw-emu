import { expect, test } from "vitest";
import { menuTemplate } from "../../src/main/menu";
import { initializeLocale } from "../../src/shared/locale";
test("menus group editing roles and provide one stable quit on every platform", () => {
  initializeLocale("en");
  for (const platform of ["darwin", "linux", "win32"]) {
    const template = menuTemplate(platform, { open() {}, make() {} });
    const flatten = (items: any[]): any[] =>
      items.flatMap((i) => [
        i,
        ...flatten(Array.isArray(i.submenu) ? i.submenu : []),
      ]);
    const all = flatten(template);
    expect(all.filter((i) => i.id === "app.quit")).toHaveLength(1);
    const edit: any = template.find((i) => i.id === "menu.edit");
    expect(
      edit.submenu.filter((i: any) => i.role).map((i: any) => i.role),
    ).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    expect(
      all.some(
        (i) => i.role === "toggleDevTools" || i.role === "togglefullscreen",
      ),
    ).toBe(false);
    expect(all.find((i) => i.id === "window.close").role).toBe("close");
    expect(
      all
        .find((i) => i.id === "menu.file")
        .submenu.some((i: any) => i.id === "app.quit"),
    ).toBe(platform !== "darwin");
  }
});
test("localized chassis checkbox mirrors the stored preference on every platform", () => {
  initializeLocale("zh-CN");
  for (const platform of ["darwin", "win32", "linux"]) {
    const template = menuTemplate(platform, {
      open() {},
      make() {},
      toggleChassis() {},
      showChassis: false,
    });
    const view: any = template.find((i) => i.id === "menu.view");
    expect(view?.label).toBe("视图");
    const item = view?.submenu.find((i: any) => i.id === "view.chassis");
    expect(item).toMatchObject({
      type: "checkbox",
      checked: false,
      label: "显示机身边框",
    });
  }
});

test("pixel scale menu offers half size and six integers with one checked preset", () => {
  const selected: number[] = [];
  const template = menuTemplate("darwin", {
    open() {},
    make() {},
    pixelScale: 0.5,
    setScale: (value: number) => selected.push(value),
  });
  const view: any = template.find((i) => i.id === "menu.view");
  const items = view.submenu.find((i: any) => i.id === "view.scale").submenu;
  expect(items.map((i: any) => i.id)).toEqual([
    "view.scale.half",
    ...[1, 2, 3, 4, 5, 6].map((n) => `view.scale.${n}`),
    "view.scale.custom",
  ]);
  expect(items.filter((i: any) => i.checked).map((i: any) => i.id)).toEqual([
    "view.scale.half",
  ]);
  items[2].click();
  expect(selected).toEqual([2]);
});
