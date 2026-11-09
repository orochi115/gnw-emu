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
