import { BrowserWindow, screen } from "electron";
import { clockGeometry } from "../shared/clock-geometry";
import type { WindowState } from "../shared/contracts";

export const TITLEBAR_HEIGHT = 32;

/** Changes host geometry only; the renderer and running emulator never move. */
export class WindowMode {
  private clock = false;
  private ratio = 4 / 3;
  private model?: "mario" | "zelda";
  private frame = true;
  private density = 1;
  private actualPixels = false;
  private applyingBounds = false;
  private target?: { width: number; height: number };
  private lastPublished = "";
  private saved?: {
    bounds: Electron.Rectangle;
    maximized: boolean;
    onTop: boolean;
  };
  transitioning = false;

  constructor(
    private window: BrowserWindow,
    private publish: (state: WindowState) => void,
    private release: () => void,
    private canEnter: () => boolean,
  ) {
    this.density = screen.getDisplayMatching(window.getBounds()).scaleFactor;
    window.on("move", () => this.refreshDensity());
    window.on("resize", () => {
      if (this.applyingBounds) return;
      this.refreshDensity();
      if (this.clock && this.actualPixels && this.target) {
        const [width, height] = window.getContentSize();
        if (width !== this.target.width || height !== this.target.height)
          this.actualPixels = false;
      }
      this.changed();
    });
    screen.on("display-metrics-changed", this.refreshDensity);
    window.once("closed", () =>
      screen.removeListener("display-metrics-changed", this.refreshDensity),
    );
    window.on("focus", () => this.changed());
    window.on("blur", () => {
      release();
      this.changed();
    });
    window.on("maximize", () => this.changed());
    window.on("unmaximize", () => this.changed());
  }
  get state(): WindowState {
    return {
      clockMode: this.clock,
      pixelPerfect: this.clock && this.actualPixels,
      scaleFactor: this.density,
      focused: this.window.isFocused(),
      maximized: this.window.isMaximized(),
    };
  }
  private changed() {
    if (this.window.isDestroyed()) return;
    const value = this.state;
    const key = JSON.stringify(value);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.publish(value);
  }

  fit(model: "mario" | "zelda" | undefined, showChassis: boolean) {
    this.model = model;
    this.frame = showChassis;
    this.ratio = clockGeometry(model, showChassis, this.density).ratio;
    if (this.clock) {
      this.restoreActualSize();
      return;
    }
    if (!model && !this.clock) return;
    if (this.window.isMaximized() || this.window.isFullScreen()) return;
    const extra = this.clock ? 0 : TITLEBAR_HEIGHT;
    const area = screen.getDisplayMatching(this.window.getBounds()).workArea;
    const width = Math.max(
      320,
      Math.min(
        this.window.getContentSize()[0],
        area.width,
        (area.height - extra) * this.ratio,
      ),
    );
    this.window.setContentSize(
      Math.round(width),
      Math.round(width / this.ratio) + extra,
    );
    this.window.setAspectRatio(this.clock ? this.ratio : 0);
  }

  private refreshDensity = () => {
    if (this.window.isDestroyed() || this.applyingBounds) return;
    const density = screen.getDisplayMatching(
      this.window.getBounds(),
    ).scaleFactor;
    if (density === this.density) return;
    this.density = density;
    if (this.clock && this.actualPixels) this.restoreActualSize();
    else this.changed();
  };

  restoreActualSize() {
    if (!this.clock || this.window.isDestroyed()) return;
    this.density = screen.getDisplayMatching(
      this.window.getBounds(),
    ).scaleFactor;
    const geometry = clockGeometry(this.model, this.frame, this.density);
    this.target = geometry;
    this.actualPixels = true;
    // Keep the center stable: changing only width at a monitor boundary can
    // alternate the display with the largest intersection and recurse forever.
    const bounds = this.window.getBounds();
    this.applyingBounds = true;
    try {
      this.window.setAspectRatio(0);
      this.window.setMinimumSize(
        Math.min(80, geometry.width),
        Math.min(48, geometry.height),
      );
      this.window.setBounds({
        x: Math.round(bounds.x + (bounds.width - geometry.width) / 2),
        y: Math.round(bounds.y + (bounds.height - geometry.height) / 2),
        width: geometry.width,
        height: geometry.height,
      });
      this.window.setAspectRatio(geometry.ratio);
    } finally {
      this.applyingBounds = false;
    }
    this.changed();
  }

  async toggle() {
    if (this.transitioning) return;
    this.transitioning = true;
    this.release();
    try {
      if (!this.clock) {
        this.saved = {
          bounds: this.window.getNormalBounds(),
          maximized: this.window.isMaximized(),
          onTop: this.window.isAlwaysOnTop(),
        };
        // macOS fullscreen transitions are asynchronous: bounds are ignored until exit.
        if (this.window.isFullScreen())
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(() => {
              this.window.removeListener("leave-full-screen", done);
              reject(new Error("Fullscreen exit timed out"));
            }, 8000);
            this.window.once("leave-full-screen", done);
            this.window.setFullScreen(false);
          });
        // A runtime may finish while the host awaits the fullscreen animation.
        if (!this.canEnter()) {
          this.window.setBounds(this.saved.bounds);
          this.saved = undefined;
          return;
        }
        this.window.unmaximize();
        this.clock = true;
        this.window.setAlwaysOnTop(true);
        this.restoreActualSize();
      } else {
        this.clock = false;
        this.actualPixels = false;
        this.target = undefined;
        this.window.unmaximize();
        this.window.setAspectRatio(0);
        this.window.setMinimumSize(320, 280);
        this.window.setAlwaysOnTop(this.saved?.onTop ?? false);
        if (this.saved) {
          this.window.setBounds(this.saved.bounds);
          if (this.saved.maximized) this.window.maximize();
        }
        this.saved = undefined;
      }
    } finally {
      this.transitioning = false;
      this.release();
      this.changed();
    }
  }
}
