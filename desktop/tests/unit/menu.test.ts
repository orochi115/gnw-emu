import { expect, test } from "vitest";
import { menuTemplate, clockMenuTemplate } from "../../src/main/menu";
test("clock context offers localized docking, frame and mute with real handlers", () => {
  initializeLocale("zh-CN");
  const calls: string[] = [];
  const menu: any[] = clockMenuTemplate({
    normal: () => calls.push("normal"),
    dock: (corner) => calls.push(corner),
    clockDock: "topRight",
    canInteract: true,
    showChassis: false,
    toggleChassis: () => calls.push("frame"),
    muted: true,
    toggleMute: () => calls.push("mute"),
    quit() {},
  });
  const docking = menu.find((i) => i.id === "clock.dock");
  expect(docking.label).toBe("停靠");
  expect(
    docking.submenu.filter((i: any) => i.checked).map((i: any) => i.id),
  ).toEqual(["clock.dock.topRight"]);
  docking.submenu.find((i: any) => i.id === "clock.dock.bottomLeft").click();
  const frame = menu.find((i) => i.id === "view.chassis");
  expect(frame.checked).toBe(false);
  frame.click();
  const mute = menu.find((i) => i.id === "audio.mute");
  expect(mute.checked).toBe(true);
  mute.click();
  expect(calls).toEqual(["bottomLeft", "frame", "mute"]);
});
import { initializeLocale } from "../../src/shared/locale";
test("recent labels preserve literal ampersands on macOS and escape native mnemonics elsewhere", () => {
  initializeLocale("en");
  for (const platform of ["darwin", "linux", "win32"]) {
    const template = menuTemplate(platform, {
      open() {},
      make() {},
      recentRoms: ["/games/A&B.gnw.json"],
    });
    const file: any = template.find((i) => i.id === "menu.file");
    const recent = file.submenu.find((i: any) => i.id === "file.recent");
    expect(recent.submenu[0].label).toBe(
      platform === "darwin"
        ? "A&B.gnw.json — /games"
        : "A&&B.gnw.json — /games",
    );
  }
});
test("recent native actions capture paths and duplicate 1:1 action is absent", () => {
  initializeLocale("en");
  const calls: string[] = [];
  for (const platform of ["darwin", "linux", "win32"]) {
    const template = menuTemplate(platform, {
      open() {},
      make() {},
      recentRoms: ["/games/stock.gnw.json", "/backup/stock.gnw.json"],
      loadRecent: (path: string) => calls.push(path),
      clearRecent: () => calls.push("clear"),
    });
    const file: any = template.find((i) => i.id === "menu.file");
    const recent = file.submenu.find((i: any) => i.id === "file.recent");
    expect(recent.label).toBe("Load Recent");
    expect(recent.submenu[0].label).not.toBe(recent.submenu[1].label);
    recent.submenu[1].click();
    recent.submenu.find((i: any) => i.id === "file.recent.clear").click();
    const view: any = template.find((i) => i.id === "menu.view");
    expect(view.submenu.some((i: any) => i.id === "view.actualSize")).toBe(
      false,
    );
  }
  expect(calls).toEqual(
    Array(3).fill(["/backup/stock.gnw.json", "clear"]).flat(),
  );
});
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

test("state menu shows ten checked slots, save time and real callbacks", async () => {
  const { stateMenuTemplate } = await import("../../src/main/menu");
  initializeLocale("en");
  const calls: unknown[] = [];
  const item: any = stateMenuTemplate({
    stateSlot: 3,
    canState: true,
    stateSlots: [null, null, null, "2026-11-11T00:00:00Z"],
    saveState: () => calls.push("save"),
    loadState: () => calls.push("load"),
    selectStateSlot: (slot) => calls.push(slot),
  });
  expect(item.submenu.filter((i: any) => i.type === "radio")).toHaveLength(10);
  expect(item.submenu.find((i: any) => i.id === "state.slot.3")).toMatchObject({
    checked: true,
  });
  expect(
    item.submenu.find((i: any) => i.id === "state.slot.3").label,
  ).toContain("2026");
  item.submenu.find((i: any) => i.id === "state.save").click();
  item.submenu.find((i: any) => i.id === "state.slot.9").click();
  expect(calls).toEqual(["save", 9]);
});

test("clock context omits device and instant states while normal menus retain them", () => {
  const actions = {
    normal() {},
    dock() {},
    clockDock: "none" as const,
    canInteract: true,
    showChassis: true,
    toggleChassis() {},
    muted: false,
    toggleMute() {},
    quit() {},
    deviceSupported: true,
  };
  expect(clockMenuTemplate(actions).map((i) => i.id)).not.toContain(
    "menu.device",
  );
  expect(clockMenuTemplate(actions).map((i) => i.id)).not.toContain(
    "menu.state",
  );
  const normal = menuTemplate("win32", { ...actions, open() {}, make() {} });
  expect(normal.map((i) => i.id)).toContain("menu.device");
  const file: any = normal.find((i) => i.id === "menu.file");
  expect(file.submenu.map((i: any) => i.id)).toContain("menu.state");
});
