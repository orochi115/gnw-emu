import type { MenuItemConstructorOptions as Item } from "electron";
import { t } from "../shared/locale";
import { SCALE_PRESETS, scaleMenuId } from "../shared/clock-geometry";
import { basename, dirname } from "node:path";
import { DOCK_CORNERS, type DockCorner } from "../shared/dock-geometry";

type ScaleActions = Parameters<typeof scaleMenuTemplate>[0];
export function clockMenuTemplate(
  actions: ScaleActions & {
    normal: () => void;
    dock: (corner: DockCorner) => void;
    clockDock: DockCorner;
    canInteract: boolean;
    showChassis: boolean;
    toggleChassis: () => void;
    muted: boolean;
    toggleMute: () => void;
    quit: () => void;
  },
): Item[] {
  return [
    {
      id: "view.clock",
      label: t("window.normal"),
      enabled: actions.canInteract,
      click: actions.normal,
    },
    { type: "separator" },
    {
      id: "clock.dock",
      label: t("menu.dock"),
      enabled: actions.canInteract,
      submenu: DOCK_CORNERS.map((corner) => ({
        id: `clock.dock.${corner}`,
        label: t(`menu.dock.${corner}`),
        type: "radio" as const,
        checked: actions.clockDock === corner,
        enabled: actions.canInteract,
        click: () => actions.dock(corner),
      })),
    },
    {
      id: "view.chassis",
      label: t("menu.chassis"),
      type: "checkbox",
      checked: actions.showChassis,
      enabled: actions.canInteract,
      click: actions.toggleChassis,
    },
    {
      id: "audio.mute",
      label: t("menu.mute"),
      type: "checkbox",
      checked: actions.muted,
      enabled: actions.canInteract,
      click: actions.toggleMute,
    },
    scaleMenuTemplate(actions),
    { type: "separator" },
    { id: "app.quit", label: t("menu.quit"), click: actions.quit },
  ];
}

export function scaleMenuTemplate(actions: {
  pixelScale?: number;
  setScale?: (value: number) => void;
  canScale?: (value: number) => boolean;
}): Item {
  return {
    id: "view.scale",
    label: t("menu.scale"),
    submenu: [
      ...SCALE_PRESETS.map((factor) => ({
        id: scaleMenuId(factor),
        label: `${factor}× (${320 * factor} × ${240 * factor})`,
        type: "radio" as const,
        checked: Math.abs((actions.pixelScale ?? 0) - factor) < 0.000001,
        enabled: actions.canScale?.(factor) ?? true,
        click: () => actions.setScale?.(factor),
      })),
      {
        id: "view.scale.custom",
        label: t("menu.customScale"),
        type: "radio",
        enabled: false,
        checked: !SCALE_PRESETS.some(
          (factor) => Math.abs((actions.pixelScale ?? 0) - factor) < 0.000001,
        ),
      },
    ],
  };
}
/** Explicit role lists keep Electron's default extra menus out of the product. */
export function menuTemplate(
  platform: string,
  actions: {
    open: () => void;
    make: () => void;
    openControls?: () => void;
    controlAccelerators?: Partial<Record<string, string | undefined>>;
    recentRoms?: string[];
    loadRecent?: (path: string) => void;
    clearRecent?: () => void;
    toggleChassis?: () => void;
    showChassis?: boolean;
    clockMode?: boolean;
    toggleClock?: () => void;
    muted?: boolean;
    toggleMute?: () => void;
    pixelScale?: number;
    setScale?: (value: number) => void;
    canScale?: (value: number) => boolean;
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
          accelerator: actions.controlAccelerators
            ? actions.controlAccelerators["file.open"]
            : "CmdOrCtrl+O",
          registerAccelerator: !actions.controlAccelerators,
          click: actions.open,
        },
        {
          id: "file.recent",
          label: t("menu.recent"),
          enabled: !!actions.recentRoms?.length,
          submenu: [
            ...(actions.recentRoms ?? []).map((path, index) => ({
              id: `file.recent.${index}`,
              // Electron uses ampersands as mnemonic markers on Windows/Linux.
              label:
                platform === "darwin"
                  ? `${basename(path)} — ${dirname(path)}`
                  : `${basename(path)} — ${dirname(path)}`.replaceAll(
                      "&",
                      "&&",
                    ),
              click: () => actions.loadRecent?.(path),
            })),
            separator,
            {
              id: "file.recent.clear",
              label: t("menu.clearRecent"),
              click: actions.clearRecent,
            },
          ],
        },
        {
          id: "file.make",
          label: t("menu.make"),
          accelerator: actions.controlAccelerators
            ? actions.controlAccelerators["file.make"]
            : "CmdOrCtrl+N",
          registerAccelerator: !actions.controlAccelerators,
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
        ...(actions.openControls
          ? [
              separator,
              {
                id: "controls.open",
                label: t("menu.controls"),
                click: actions.openControls,
              },
            ]
          : []),
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
        scaleMenuTemplate(actions),
        {
          id: "audio.mute",
          label: t("menu.mute"),
          type: "checkbox",
          checked: actions.muted ?? false,
          click: actions.toggleMute,
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
