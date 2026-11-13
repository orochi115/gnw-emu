import { BrowserWindow, screen } from "electron";
import { clockGeometry } from "../shared/clock-geometry";
import {
  dockBounds,
  nearestDock,
  DOCK_CORNERS,
  type DockCorner,
} from "../shared/dock-geometry";
import type { WindowState } from "../shared/contracts";
import type { Settings } from "../core/schemas";
import type { ViewSettingsPatch } from "../core/view-settings";

export const TITLEBAR_HEIGHT = 32;
type Placement = NonNullable<Settings["clockBounds"]>;

/** Owns host geometry and display preferences; never rebuilds the emulator/canvas. */
export class WindowMode {
  private clock = false;
  private preferredClock: boolean;
  private normalScale: number;
  private clockScale: number;
  private placement?: Placement;
  private dock: DockCorner;
  private dockTarget?: { x: number; y: number };
  private dragging?: {
    cursor: Electron.Point;
    bounds: Electron.Rectangle;
    moved: boolean;
  };
  private model?: "mario" | "zelda";
  private frame = true;
  private density = 1;
  private exactScale?: number;
  private fixedExpanded = false;
  private applyingBounds = false;
  private gameAvailable = true;
  private modal = false;
  private modalBounds?: Electron.Rectangle;
  private target?: { width: number; height: number };
  private manualTimer?: ReturnType<typeof setTimeout>;
  private manualCandidate?: { factor: number; width: number; height: number };
  private lastPublished = "";
  private saved?: {
    bounds: Electron.Rectangle;
    maximized: boolean;
    onTop: boolean;
    maximizable: boolean;
    fullscreenable: boolean;
  };
  transitioning = false;

  constructor(
    private window: BrowserWindow,
    private publish: (state: WindowState) => void,
    private release: () => void,
    private canEnter: () => boolean,
    settings: Partial<Settings> = {},
    private persist: (patch: ViewSettingsPatch) => void = () => {},
    private move: (x: number, y: number) => void = (x, y) =>
      window.setBounds({ x, y }),
  ) {
    this.normalScale = settings.normalScale ?? 4;
    this.clockScale = settings.clockScale ?? 1;
    this.preferredClock = settings.clockMode ?? false;
    this.placement = settings.clockBounds;
    this.dock = settings.clockDock ?? "none";
    this.density = screen.getDisplayMatching(window.getBounds()).scaleFactor;
    window.on("move", () => {
      if (this.applyingBounds || this.transitioning) return;
      const bounds = window.getBounds();
      if (
        this.clock &&
        this.dock !== "none" &&
        this.dockTarget &&
        (bounds.x !== this.dockTarget.x || bounds.y !== this.dockTarget.y)
      ) {
        this.dock = "none";
        this.dockTarget = undefined;
        this.persist({ clockDock: "none" });
      }
      this.refreshDensity();
      this.recordPlacement();
      this.changed();
    });
    window.on("resize", () => {
      if (this.applyingBounds || this.transitioning || this.modal) return;
      this.refreshDensity();
      if (this.model && this.gameAvailable && this.settledWindowed) {
        const [width, height] = window.getContentSize();
        if (
          !this.target ||
          width !== this.target.width ||
          height !== this.target.height
        ) {
          this.exactScale = undefined;
          this.target = undefined;
          this.queueManualScale();
        }
        this.recordPlacement();
        this.applyDock();
      }
      this.changed();
    });
    screen.on("display-metrics-changed", this.refreshDensity);
    window.once("closed", () => {
      clearTimeout(this.manualTimer);
      screen.removeListener("display-metrics-changed", this.refreshDensity);
    });
    window.on("focus", () => this.changed());
    window.on("blur", () => {
      release();
      this.changed();
    });
    window.on("maximize", () => {
      this.finishExpandedEntry();
      this.fixedExpanded = false;
      this.changed();
    });
    window.on("unmaximize", () => {
      this.restoreExpandedFactor();
    });
    window.on("enter-full-screen", () => {
      this.finishExpandedEntry();
      this.fixedExpanded = false;
      this.changed();
    });
    window.on("leave-full-screen", () => {
      this.restoreExpandedFactor();
    });
  }
  private get expanded() {
    return this.window.isMaximized() || this.window.isFullScreen();
  }
  private get settledWindowed() {
    const bounds = this.window.getBounds(),
      normal = this.window.getNormalBounds();
    // Native animations can emit resize before the expanded-state flag changes.
    return (
      !this.expanded &&
      bounds.width === normal.width &&
      bounds.height === normal.height
    );
  }
  private restoreExpandedFactor() {
    this.fixedExpanded = false;
    if (
      !this.applyingBounds &&
      !this.transitioning &&
      this.model &&
      this.gameAvailable &&
      !this.expanded
    )
      this.applyScale(
        this.restoredScale(this.rememberedScale),
        undefined,
        true,
      );
    else this.changed();
  }
  private finishExpandedEntry() {
    // Preserve a genuine preceding manual resize, discard native animation sizes.
    const normal = this.window.getNormalBounds(),
      candidate = this.manualCandidate;
    if (
      candidate &&
      candidate.width === normal.width &&
      candidate.height === normal.height
    )
      this.rememberScale(candidate.factor);
    this.cancelManualScale();
  }
  private cancelManualScale() {
    clearTimeout(this.manualTimer);
    this.manualTimer = undefined;
    this.manualCandidate = undefined;
  }
  private queueManualScale() {
    const bounds = this.window.getBounds();
    this.manualCandidate = {
      factor: this.fitScale(),
      width: bounds.width,
      height: bounds.height,
    };
    clearTimeout(this.manualTimer);
    this.manualTimer = setTimeout(() => this.commitManualScale(), 250);
  }
  private commitManualScale() {
    const candidate = this.manualCandidate;
    this.cancelManualScale();
    if (
      candidate &&
      this.model &&
      this.gameAvailable &&
      !this.modal &&
      this.settledWindowed
    )
      this.rememberScale(this.fitScale());
    this.changed();
  }
  flushPreferences() {
    this.commitManualScale();
    this.recordPlacement();
  }
  private get rememberedScale() {
    return this.clock ? this.clockScale : this.normalScale;
  }
  private fitScale() {
    const unit = clockGeometry(this.model, this.frame, this.density);
    const [width, height] = this.window.getContentSize();
    return Math.max(
      0.05,
      Math.min(
        64,
        width / unit.layoutWidth,
        Math.max(1, height - (this.clock ? 0 : TITLEBAR_HEIGHT)) /
          unit.layoutHeight,
      ),
    );
  }
  get state(): WindowState {
    const renderScale =
      this.modal || (this.expanded && !this.fixedExpanded)
        ? null
        : (this.exactScale ?? null);
    return {
      clockMode: this.clock,
      clockDock: this.dock,
      preferredClockMode: this.preferredClock,
      transitioning: this.transitioning,
      pixelPerfect: renderScale !== null && Number.isInteger(renderScale),
      pixelScale:
        renderScale ?? (this.model ? this.fitScale() : this.rememberedScale),
      renderScale,
      normalScale: this.normalScale,
      clockScale: this.clockScale,
      scaleFactor: this.density,
      controlWidth: Math.min(
        this.window.getBounds().width,
        screen.getDisplayMatching(this.window.getBounds()).workArea.width,
      ),
      focused: this.window.isFocused(),
      maximized: this.window.isMaximized(),
    };
  }
  private changed() {
    if (this.window.isDestroyed()) return;
    const value = this.state,
      key = JSON.stringify(value);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.publish(value);
  }
  private rememberScale(factor: number) {
    if (this.clock) {
      this.clockScale = factor;
      this.persist({ clockScale: factor });
    } else {
      this.normalScale = factor;
      this.persist({ normalScale: factor });
    }
  }
  private recordPlacement() {
    if (
      !this.clock ||
      this.window.isDestroyed() ||
      this.modal ||
      !this.settledWindowed
    )
      return;
    this.placement = {
      ...this.window.getBounds(),
      displayId: screen.getDisplayMatching(this.window.getBounds()).id,
    };
    this.persist({ clockBounds: this.placement });
  }
  setDock(corner: DockCorner) {
    if (!DOCK_CORNERS.includes(corner)) throw Error("Invalid dock corner");
    if (!this.clock || this.transitioning || this.modal)
      throw Error("Clock mode is busy");
    this.commitManualScale();
    this.release();
    this.dock = corner;
    this.dockTarget = undefined;
    this.persist({ clockDock: corner });
    this.applyDock();
    this.recordPlacement();
    this.changed();
  }
  /** Windows clock drag stays in the client area: no caption menu or double-click. */
  drag(action: "start" | "move" | "end", cursor: Electron.Point) {
    if (!this.clock || this.transitioning || this.modal || !this.canEnter()) {
      this.dragging = undefined;
      return;
    }
    if (action === "start") {
      this.dragging = { cursor, bounds: this.window.getBounds(), moved: false };
      return;
    }
    const drag = this.dragging;
    if (!drag) return;
    const dx = cursor.x - drag.cursor.x,
      dy = cursor.y - drag.cursor.y;
    if (Math.abs(dx) + Math.abs(dy) >= 3 || drag.moved) {
      if (!drag.moved) {
        this.release();
        this.dock = "none";
        this.dockTarget = undefined;
        this.persist({ clockDock: "none" });
        drag.moved = true;
      }
      this.applyingBounds = true;
      try {
        this.move(drag.bounds.x + dx, drag.bounds.y + dy);
      } finally {
        this.applyingBounds = false;
      }
      this.refreshDensity();
    }
    if (action === "end") {
      this.dragging = undefined;
      if (drag.moved) {
        const bounds = this.window.getBounds();
        this.setDock(
          nearestDock(bounds, screen.getDisplayMatching(bounds).workArea),
        );
      }
    }
  }
  private applyDock() {
    if (!this.clock || this.dock === "none" || this.applyingBounds) return;
    const bounds = this.window.getBounds();
    const next = dockBounds(
      bounds,
      screen.getDisplayMatching(bounds).workArea,
      this.dock,
    );
    this.dockTarget = { x: next.x, y: next.y };
    if (next.x !== bounds.x || next.y !== bounds.y) {
      this.applyingBounds = true;
      try {
        this.move(next.x, next.y);
      } finally {
        this.applyingBounds = false;
      }
    }
    this.recordPlacement();
  }
  /** Empty/error and maker views have their own minimum, never a game scale. */
  setGameAvailable(available: boolean) {
    if (this.gameAvailable === available) return;
    this.gameAvailable = available;
    if (!available && !this.clock) this.usableMinimum();
    else if (
      available &&
      this.model &&
      !this.clock &&
      !this.modal &&
      !this.expanded
    )
      this.applyScale(this.restoredScale(this.normalScale), undefined, true);
  }
  setModal(open: boolean, minimum?: { width: number; height: number }) {
    if (this.modal === open) return;
    if (open) {
      this.commitManualScale();
      this.modalBounds = this.window.getBounds();
      this.modal = true;
      this.usableMinimum(minimum);
    } else {
      this.modal = false;
      if (this.model && this.gameAvailable && !this.expanded)
        this.applyScale(this.rememberedScale, this.modalBounds);
      else if (minimum && this.modalBounds) {
        this.window.setMinimumSize(320, 280);
        this.window.setBounds(this.modalBounds);
      }
      this.modalBounds = undefined;
    }
    this.changed();
  }
  private usableMinimum(minimum = { width: 320, height: 280 }) {
    this.applyingBounds = true;
    try {
      const work = screen.getDisplayMatching(this.window.getBounds()).workArea;
      const targetWidth = Math.min(minimum.width, work.width);
      const targetHeight = Math.min(minimum.height, work.height);
      this.window.setMinimumSize(targetWidth, targetHeight);
      const [w, h] = this.window.getContentSize();
      if (w < targetWidth || h < targetHeight)
        this.window.setContentSize(
          Math.max(targetWidth, w),
          Math.max(targetHeight, h),
        );
    } finally {
      this.applyingBounds = false;
    }
  }
  async fit(model: "mario" | "zelda" | undefined, showChassis: boolean) {
    let factor =
      this.model && this.gameAvailable
        ? this.state.pixelScale
        : this.rememberedScale;
    const restoring = this.model !== model;
    const expanded = this.expanded;
    this.model = model;
    this.frame = showChassis;
    if (!model || !this.gameAvailable) {
      this.changed();
      return;
    }
    if (expanded) {
      const geometry = clockGeometry(model, showChassis, this.density, factor);
      const [width, height] = this.window.getContentSize();
      if (
        geometry.width <= width &&
        geometry.height + TITLEBAR_HEIGHT <= height
      ) {
        this.exactScale = factor;
        this.fixedExpanded = true;
        this.changed();
        return;
      }
      await this.leaveFullscreen();
      if (!this.gameAvailable || this.model !== model) return;
      this.applyingBounds = true;
      try {
        this.window.unmaximize();
      } finally {
        this.applyingBounds = false;
      }
    }
    if (restoring) factor = this.restoredScale(factor);
    this.rememberScale(factor);
    this.applyScale(factor, undefined, restoring);
  }
  private refreshDensity = () => {
    if (
      this.window.isDestroyed() ||
      this.applyingBounds ||
      this.transitioning ||
      this.modal
    )
      return;
    const density = screen.getDisplayMatching(
      this.window.getBounds(),
    ).scaleFactor;
    if (density === this.density) {
      this.applyDock();
      this.changed();
      return;
    }
    this.density = density;
    if (
      this.model &&
      this.gameAvailable &&
      this.exactScale !== undefined &&
      this.settledWindowed
    )
      this.applyScale(this.exactScale);
    else {
      if (this.model && this.gameAvailable && this.settledWindowed)
        this.queueManualScale();
      this.changed();
    }
  };
  /** Fit restored normal windows without altering an already fitting preference. */
  private restoredScale(factor: number, anchor = this.window.getBounds()) {
    if (this.clock) return factor;
    const display = screen.getDisplayMatching(anchor);
    const unit = clockGeometry(this.model, this.frame, display.scaleFactor);
    const limit = Math.min(
      Math.floor(display.workArea.width) / unit.layoutWidth,
      Math.floor(display.workArea.height - TITLEBAR_HEIGHT) / unit.layoutHeight,
    );
    if (factor <= limit) return factor;
    // Prefer integer LCD pixels, then half scale, with a fractional fallback.
    const fitted =
      limit >= 1
        ? Math.floor(limit)
        : limit >= 0.5
          ? 0.5
          : Math.max(0.05, Math.floor(limit * 1e6) / 1e6);
    this.rememberScale(fitted);
    return fitted;
  }
  /** Restores keep the whole window visible; frame changes keep its center. */
  private applyScale(
    factor: number,
    anchor = this.window.getBounds(),
    restorePlacement = false,
  ) {
    this.cancelManualScale();
    const display = screen.getDisplayMatching(anchor);
    this.density = display.scaleFactor;
    const geometry = clockGeometry(
      this.model,
      this.frame,
      this.density,
      factor,
    );
    const width = geometry.width,
      height = geometry.height + (this.clock ? 0 : TITLEBAR_HEIGHT);
    let x = Math.round(anchor.x + (anchor.width - width) / 2),
      y = Math.round(anchor.y + (anchor.height - height) / 2);
    if (restorePlacement || !this.clock) {
      const area = display.workArea;
      const controlWidth = Math.min(width, area.width);
      x = Math.max(
        area.x ?? 0,
        Math.min(x, (area.x ?? 0) + Math.max(0, area.width - controlWidth)),
      );
      y = Math.max(
        area.y ?? 0,
        Math.min(
          y,
          (area.y ?? 0) +
            Math.max(
              0,
              area.height -
                (restorePlacement || this.clock ? height : TITLEBAR_HEIGHT),
            ),
        ),
      );
    }
    this.target = { width, height };
    if (this.clock && this.dock !== "none") {
      const pinned = dockBounds(
        { x, y, width, height },
        display.workArea,
        this.dock,
      );
      x = pinned.x;
      y = pinned.y;
      this.dockTarget = { x, y };
    } else this.dockTarget = undefined;
    this.exactScale = factor;
    this.fixedExpanded = false;
    // Keep the center stable and ignore intermediate native resize/move events.
    this.applyingBounds = true;
    try {
      this.window.setAspectRatio(0);
      this.window.setMinimumSize(
        Math.min(80, width),
        Math.min(this.clock ? 48 : 80, height),
      );
      this.window.setBounds({ x, y, width, height });
      if (this.clock) this.window.setAspectRatio(geometry.ratio);
    } finally {
      this.applyingBounds = false;
    }
    this.recordPlacement();
    this.changed();
  }
  canSetScale(factor: number) {
    const display = screen.getDisplayMatching(this.window.getBounds());
    const geometry = clockGeometry(
      this.model,
      this.frame,
      display.scaleFactor,
      factor,
    );
    return (
      geometry.width <= display.workArea.width &&
      geometry.height + (this.clock ? 0 : TITLEBAR_HEIGHT) <=
        display.workArea.height
    );
  }
  async setScale(factor: number) {
    if (!Number.isFinite(factor) || factor < 0.05 || factor > 64)
      throw Error("Invalid pixel scale");
    if (this.transitioning || this.modal || !this.model || !this.gameAvailable)
      return;
    this.transitioning = true;
    this.release();
    this.changed();
    try {
      await this.leaveFullscreen();
      if (!this.canEnter()) return;
      this.window.unmaximize();
      this.rememberScale(factor);
      this.applyScale(factor);
    } finally {
      this.transitioning = false;
      this.release();
      this.changed();
    }
  }
  private async leaveFullscreen() {
    if (!this.window.isFullScreen()) return;
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
  }
  async toggle(remember = true) {
    if (this.transitioning) return;
    this.commitManualScale();
    this.transitioning = true;
    this.release();
    this.changed();
    try {
      if (!this.clock) {
        this.saved = {
          bounds: this.window.getNormalBounds(),
          maximized: this.window.isMaximized(),
          onTop: this.window.isAlwaysOnTop(),
          maximizable: this.window.isMaximizable?.() ?? true,
          fullscreenable: this.window.isFullScreenable?.() ?? true,
        };
        await this.leaveFullscreen();
        if (!this.canEnter()) {
          this.window.setBounds(this.saved.bounds);
          this.saved = undefined;
          return;
        }
        this.window.unmaximize();
        this.clock = true;
        this.window.setMaximizable?.(false);
        this.window.setFullScreenable?.(false);
        this.window.setAlwaysOnTop(true);
        this.applyScale(
          this.clockScale,
          this.placement ?? this.window.getBounds(),
          !!this.placement,
        );
      } else {
        this.recordPlacement();
        this.dragging = undefined;
        this.clock = false;
        this.window.unmaximize();
        this.window.setAspectRatio(0);
        this.window.setAlwaysOnTop(this.saved?.onTop ?? false);
        this.window.setMaximizable?.(this.saved?.maximizable ?? true);
        this.window.setFullScreenable?.(this.saved?.fullscreenable ?? true);
        this.applyScale(
          this.restoredScale(this.normalScale, this.saved?.bounds),
          this.saved?.bounds,
          true,
        );
        if (this.saved?.maximized) this.window.maximize();
        this.saved = undefined;
        if (!this.gameAvailable) this.usableMinimum();
      }
      if (remember) {
        this.preferredClock = this.clock;
        this.persist({ clockMode: this.clock });
      }
    } finally {
      this.transitioning = false;
      this.release();
      this.changed();
    }
  }
}
