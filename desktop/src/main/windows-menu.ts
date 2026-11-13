import { createRequire } from "node:module";
import type { BrowserWindow, Menu, MenuItem } from "electron";

interface NativeEntry {
  label: string;
  type: string;
  enabled: boolean;
  checked: boolean;
  command?: number;
  children?: NativeEntry[];
}

/** Electron remains the command model, including its role and checkbox wrappers. */
export function nativeMenuModel(menu: Menu) {
  const commands = new Map<number, { item: MenuItem; parents: MenuItem[] }>();
  let next = 1;
  const entries = (
    items: MenuItem[],
    parents: MenuItem[] = [],
  ): NativeEntry[] =>
    items
      .filter((item) => item.visible)
      .map((item) => {
        const hint = item.accelerator?.replace(
          /CommandOrControl|CmdOrCtrl|Control/g,
          "Ctrl",
        );
        const entry: NativeEntry = {
          label: item.label + (hint ? `\t${hint}` : ""),
          type: item.type,
          enabled: item.enabled,
          checked: item.checked,
        };
        if (item.submenu)
          entry.children = entries(item.submenu.items, [...parents, item]);
        else if (item.type !== "separator") {
          entry.command = next++;
          commands.set(entry.command, { item, parents });
        }
        return entry;
      });
  return {
    entries: entries(menu.items),
    invoke(command: number, window: BrowserWindow) {
      const action = commands.get(command);
      if (
        !action ||
        [action.item, ...action.parents].some(
          (item) => !item.enabled || !item.visible,
        )
      )
        return;
      action.item.click(
        { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
        window,
        window.webContents,
      );
    },
  };
}

let api: ReturnType<typeof loadApi> | undefined;
let open = false;
function loadApi() {
  // Load only in the Windows main process. Koffi ships N-API prebuilt binaries.
  const koffi: typeof import("koffi") = createRequire(import.meta.url)("koffi");
  const user32 = koffi.load("user32.dll");
  const point = koffi.struct("GNW_MENU_POINT", { x: "long", y: "long" });
  const info = koffi.struct("GNW_MENUITEMINFO", {
    cbSize: "uint32",
    fMask: "uint32",
    fType: "uint32",
    fState: "uint32",
    wID: "uint32",
    hSubMenu: "void *",
    hbmpChecked: "void *",
    hbmpUnchecked: "void *",
    dwItemData: "uintptr_t",
    dwTypeData: "void *",
    cch: "uint32",
    hbmpItem: "void *",
  });
  return {
    koffi,
    info,
    create: user32.func("void * __stdcall CreatePopupMenu()"),
    append: user32.func(
      "int __stdcall AppendMenuW(void *menu, uint32 flags, uintptr_t id, str16 text)",
    ),
    destroy: user32.func("int __stdcall DestroyMenu(void *menu)"),
    radio: user32.func("__stdcall", "SetMenuItemInfoW", "int", [
      "void *",
      "uint32",
      "int",
      koffi.pointer(info),
    ]),
    cursor: user32.func("__stdcall", "GetCursorPos", "int", [
      koffi.out(koffi.pointer(point)),
    ]),
    foreground: user32.func("int __stdcall SetForegroundWindow(void *window)"),
    track: user32.func(
      "uint32 __stdcall TrackPopupMenuEx(void *menu, uint32 flags, int x, int y, void *window, void *params)",
    ),
    post: user32.func(
      "int __stdcall PostMessageW(void *window, uint32 message, uintptr_t wParam, intptr_t lParam)",
    ),
  };
}

/** A real HMENU (#32768), with all handles destroyed even on build/cancel errors. */
export function popupWindowsMenu(menu: Menu, window: BrowserWindow) {
  if (open || window.isDestroyed()) return;
  const native = (api ??= loadApi());
  const model = nativeMenuModel(menu);
  const build = (entries: NativeEntry[]): any => {
    const handle = native.create();
    if (!handle) throw new Error("CreatePopupMenu failed");
    try {
      entries.forEach((item, index) => {
        const child = item.children ? build(item.children) : undefined;
        const flags =
          item.type === "separator"
            ? 0x800
            : (child ? 0x10 : 0) |
              (!item.enabled ? 1 : 0) |
              (item.checked ? 8 : 0);
        const id = child ? native.koffi.address(child) : (item.command ?? 0);
        if (!native.append(handle, flags, id, item.label)) {
          if (child) native.destroy(child);
          throw new Error("AppendMenuW failed");
        }
        if (
          item.type === "radio" &&
          !native.radio(handle, index, 1, {
            cbSize: native.koffi.sizeof(native.info),
            fMask: 0x100,
            fType: 0x200,
          })
        )
          throw new Error("SetMenuItemInfoW failed");
      });
      return handle;
    } catch (error) {
      native.destroy(handle);
      throw error;
    }
  };
  const handle = build(model.entries);
  let command = 0;
  open = true;
  try {
    const hwnd = native.koffi.decode(window.getNativeWindowHandle(), "void *");
    const point = { x: 0, y: 0 };
    if (!native.cursor(point)) throw new Error("GetCursorPos failed");
    native.foreground(hwnd);
    menu.emit("menu-will-show");
    // RETURNCMD | NONOTIFY | RIGHTBUTTON; dispatch after Windows closes its loop.
    command = native.track(
      handle,
      0x100 | 0x80 | 0x2,
      point.x,
      point.y,
      hwnd,
      null,
    );
    native.post(hwnd, 0, 0, 0);
  } finally {
    native.destroy(handle);
    open = false;
    menu.emit("menu-will-close");
  }
  if (command && !window.isDestroyed()) model.invoke(command, window);
}
