import { BrowserWindow, screen } from "electron";
import type { WindowState } from "../shared/contracts";

export const TITLEBAR_HEIGHT = 32;
const ratios = { mario: 919 / 550, zelda: 950 / 567 };

/** Changes host geometry only; the renderer and running emulator never move. */
export class WindowMode {
  private clock = false;
  private ratio = 4 / 3;
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
      focused: this.window.isFocused(),
      maximized: this.window.isMaximized(),
    };
  }
  private changed() {
    this.publish(this.state);
  }

  fit(model: "mario" | "zelda" | undefined, showChassis: boolean) {
    this.ratio = model && showChassis ? ratios[model] : 4 / 3;
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
        this.window.setMinimumSize(320, 180);
        this.window.setAlwaysOnTop(true);
        this.window.setContentSize(480, Math.round(480 / this.ratio));
        this.window.setAspectRatio(this.ratio);
      } else {
        this.clock = false;
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
