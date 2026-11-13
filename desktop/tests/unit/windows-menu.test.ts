import { expect, test, vi } from "vitest";
import { nativeMenuModel } from "../../src/main/windows-menu";

test("native menu preserves Unicode, disabled parents, checks and accelerator hints", () => {
  const hidden = { label: "hidden", visible: false };
  const item = {
    label: "边框 & Frame",
    enabled: true,
    visible: true,
    type: "checkbox",
    checked: true,
    accelerator: "CommandOrControl+B",
    click: vi.fn(),
  };
  const menu = {
    items: [
      hidden,
      {
        label: "显示",
        enabled: false,
        visible: true,
        submenu: { items: [item] },
      },
      { type: "separator", visible: true },
      { ...item, type: "radio" },
    ],
  };
  const model = nativeMenuModel(menu as any);
  expect(model.entries).toHaveLength(3);
  expect(model.entries[0]).toMatchObject({ label: "显示", enabled: false });
  expect(model.entries[0].children?.[0]).toMatchObject({
    label: "边框 & Frame\tCtrl+B",
    checked: true,
    type: "checkbox",
  });
  expect(model.entries[1].type).toBe("separator");
  expect(model.entries[2].type).toBe("radio");
  model.invoke(model.entries[0].children![0].command!, {} as any);
  expect(item.click).not.toHaveBeenCalled();
  model.invoke(model.entries[2].command!, { webContents: {} } as any);
  expect(item.click).toHaveBeenCalledOnce();
});

test("native menu dispatch checks the current state and uses Electron's role/click wrapper", () => {
  const item = {
    label: "退出",
    role: "quit",
    enabled: true,
    visible: true,
    click: vi.fn(),
  };
  const model = nativeMenuModel({ items: [item] } as any);
  item.enabled = false;
  model.invoke(model.entries[0].command!, {} as any);
  expect(item.click).not.toHaveBeenCalled();
  item.enabled = true;
  const window = { webContents: {} };
  model.invoke(model.entries[0].command!, window as any);
  expect(item.click).toHaveBeenCalledWith(
    expect.any(Object),
    window,
    window.webContents,
  );
});
