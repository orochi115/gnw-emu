import type { MenuItemConstructorOptions as Item } from "electron";
import { t } from "../shared/locale";
/** Explicit role lists keep Electron's default extra menus out of the product. */
export function menuTemplate(
  platform: string,
  actions: {
    open: () => void;
    make: () => void;
    toggleChassis?: () => void;
    showChassis?: boolean;
    clockMode?: boolean;
    toggleClock?: () => void;
  },
): Item[] {
  const separator: Item = { type: "separator" };
  const quit: Item = { id: "app.quit", label: t("menu.quit"), role: "quit" };
  return [
    ...(platform === "darwin"
      ? [
          {
            id: "menu.app",
            label: "gnw-emu",
            submenu: [
              { label: t("menu.about"), role: "about" as const },
              separator,
              { label: t("menu.hide"), role: "hide" as const },
              { label: t("menu.hideOthers"), role: "hideOthers" as const },
              { label: t("menu.showAll"), role: "unhide" as const },
              separator,
              quit,
            ],
          },
        ]
      : []),
    {
      id: "menu.file",
      label: t("menu.file"),
      submenu: [
        {
          id: "file.open",
          label: t("menu.open"),
          accelerator: "CmdOrCtrl+O",
          click: actions.open,
        },
        {
          id: "file.make",
          label: t("menu.make"),
          accelerator: "CmdOrCtrl+N",
          click: actions.make,
        },
        ...(platform === "darwin" ? [] : [separator, quit]),
      ],
    },
    {
      id: "menu.edit",
      label: t("menu.edit"),
      submenu: [
        { id: "edit.undo", label: t("menu.undo"), role: "undo" },
        { id: "edit.redo", label: t("menu.redo"), role: "redo" },
        separator,
        { id: "edit.cut", label: t("menu.cut"), role: "cut" },
        { id: "edit.copy", label: t("menu.copy"), role: "copy" },
        { id: "edit.paste", label: t("menu.paste"), role: "paste" },
        separator,
        { id: "edit.selectAll", label: t("menu.selectAll"), role: "selectAll" },
      ],
    },
    {
      id: "menu.view",
      label: t("menu.view"),
      submenu: [
        {
          id: "view.chassis",
          label: t("menu.chassis"),
          type: "checkbox",
          checked: actions.showChassis ?? true,
          click: actions.toggleChassis,
        },
        {
          id: "view.clock",
          label: t("menu.clock"),
          type: "checkbox",
          checked: actions.clockMode ?? false,
          click: actions.toggleClock,
        },
      ],
    },
    {
      id: "menu.window",
      label: t("menu.window"),
      submenu: [
        { id: "window.minimize", label: t("menu.minimize"), role: "minimize" },
        ...(platform === "darwin"
          ? [
              {
                id: "window.zoom",
                label: t("menu.zoom"),
                role: "zoom" as const,
              },
              separator,
              {
                id: "window.front",
                label: t("menu.front"),
                role: "front" as const,
              },
              separator,
            ]
          : []),
        { id: "window.close", label: t("menu.close"), role: "close" },
      ],
    },
  ];
}
