import { BrowserWindow, screen } from "electron";
import {
  controlsWindowBounds,
  type ControlPage,
} from "./control-window-geometry";
/** Owns one independent settings window; the caller owns input isolation and transactions. */
export class ControlWindow {
  window?: BrowserWindow;
  page?: ControlPage;
  private remembered: Partial<Record<ControlPage, Electron.Rectangle>> = {};
  constructor(
    private options: {
      parent: BrowserWindow;
      preload: string;
      renderer: string;
      devUrl?: string;
      title(page: ControlPage): string;
      canClose(): boolean;
      closed(): void;
    },
  ) {}
  async open(page: ControlPage) {
    if (this.window) {
      this.window.show();
      this.window.focus();
      return;
    }
    const parent = this.options.parent,
      area = screen.getDisplayMatching(parent.getBounds()).workArea;
    const bounds = controlsWindowBounds(
      page,
      parent.getBounds(),
      area,
      this.remembered[page],
    );
    const child = new BrowserWindow({
      ...bounds,
      parent,
      show: false,
      title: this.options.title(page),
      backgroundColor: "#fafbf7",
      autoHideMenuBar: true,
      alwaysOnTop: parent.isAlwaysOnTop(),
      minWidth: Math.min(page === "buttons" ? 900 : 560, area.width),
      minHeight: Math.min(page === "buttons" ? 600 : 420, area.height),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.window = child;
    this.page = page;
    child.setMenuBarVisibility(false);
    child.webContents.setIgnoreMenuShortcuts(true);
    child.webContents.on("before-input-event", () =>
      child.webContents.setIgnoreMenuShortcuts(true),
    );
    child.on("page-title-updated", (event) => event.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.on("close", (event) => {
      if (!this.options.canClose()) event.preventDefault();
    });
    child.on("closed", () => {
      if (this.window !== child) return;
      this.window = undefined;
      this.page = undefined;
      this.options.closed();
    });
    const remember = () => {
      if (!child.isDestroyed() && !child.isMaximized() && !child.isFullScreen())
        this.remembered[page] = child.getBounds();
    };
    child.on("resize", remember);
    child.on("move", remember);
    child.webContents.on("render-process-gone", () => this.destroy());
    try {
      if (this.options.devUrl) {
        const url = new URL(this.options.devUrl);
        url.searchParams.set("controlsPage", page);
        await child.loadURL(url.toString());
      } else
        await child.loadFile(this.options.renderer, {
          query: { controlsPage: page },
        });
      if (this.window === child && !child.isDestroyed()) {
        child.show();
        child.focus();
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  destroy() {
    const child = this.window;
    if (child && !child.isDestroyed()) child.destroy();
  }
}
