import type { ProfileFields } from "../core/schemas";
import type { DockCorner } from "./dock-geometry";
import type {
  ControlsSettings,
  ControlInputEvent,
  GamepadParticipation,
} from "./controls";
export type AppStatus = "idle" | "starting" | "running" | "stopping" | "error";
export interface InputState {
  runtimeSessionId?: string;
  desiredMask: number;
  appliedMask: number;
  resetGeneration: number;
}
export interface MenuBarItem {
  id: string;
  label: string;
  enabled: boolean;
}
export interface WindowState {
  clockMode: boolean;
  clockDock: DockCorner;
  pixelPerfect: boolean;
  scaleFactor: number;
  pixelScale: number;
  renderScale: number | null;
  normalScale: number;
  clockScale: number;
  preferredClockMode: boolean;
  transitioning: boolean;
  controlWidth: number;
  focused: boolean;
  maximized: boolean;
}
export interface ViewPreferences {
  showChassis: boolean;
}
export interface ToastMessage {
  code: string;
  params?: Record<string, string | number>;
  kind: "progress" | "success" | "info" | "error";
  duration?: number;
}
export interface AppState {
  execution?: "running" | "paused" | "unpowered" | "unknown";
  devicePower?: {
    battery: number;
    batteryPresent: boolean;
    usbPower: boolean;
    powered: boolean;
  };
  deviceOperation?: boolean;
  canInstantState?: boolean;
  stateSlot?: number;
  stateSlots?: (string | null)[];
  stateOperation?: "save" | "load";
  status: AppStatus;
  stage?: string;
  runtimeSessionId?: string;
  profileName?: string;
  profilePath?: string;
  model?: "zelda" | "mario";
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  saveUncertain?: boolean;
}
export interface DesktopApi {
  onToast(callback: (value: ToastMessage) => void): () => void;
  controls(): Promise<ControlsSettings>;
  openControls(page?: "buttons" | "hotkeys"): Promise<void>;
  controlsWindow(): Promise<{
    page: "buttons" | "hotkeys";
    model: "mario" | "zelda";
    config: ControlsSettings;
    epoch: number;
    participation: GamepadParticipation[];
  } | null>;
  onControlsClosed(callback: () => void): () => void;
  saveControls(
    config: ControlsSettings,
    participation?: GamepadParticipation[],
  ): Promise<void>;
  reportControlDevices(devices: GamepadParticipation[]): void;
  onControlParticipation(
    callback: (devices: GamepadParticipation[]) => void,
  ): () => void;
  closeControls(): Promise<void>;
  controlInput(event: ControlInputEvent): void;
  onControlsChanged(callback: (config: ControlsSettings) => void): () => void;
  onControlsOpen(
    callback: (value: { config: ControlsSettings; epoch: number }) => void,
  ): () => void;
  onInputEpoch(callback: (epoch: number) => void): () => void;
  inputEpoch(): Promise<number>;
  windowState(): Promise<WindowState>;
  menuBar(): Promise<MenuBarItem[]>;
  onMenuBar(callback: (items: MenuBarItem[]) => void): () => void;
  openMenu(id: string, anchor: { x: number; y: number }): Promise<void>;
  onWindowState(callback: (value: WindowState) => void): () => void;
  windowAction(
    action: "menu" | "minimize" | "maximize" | "close" | "normal",
  ): Promise<void>;
  clockDrag(action: "start" | "move" | "end"): void;
  locale(): Promise<"zh-CN" | "en">;
  state(): Promise<AppState>;
  onState(callback: (state: AppState) => void): () => void;
  preferences(): Promise<ViewPreferences>;
  onPreferences(callback: (value: ViewPreferences) => void): () => void;
  inputState(): Promise<InputState>;
  onInput(callback: (value: InputState) => void): () => void;
  button(
    bit: number,
    down: boolean,
    source: string,
    runtimeSessionId: string,
  ): void;
  releaseChassis(runtimeSessionId: string): void;
  openRom(): Promise<void>;
  openDroppedRom(file: File): Promise<void>;
  makeRom(): Promise<void>;
  pickImage(field: string): Promise<string | null>;
  saveRom(
    fields: ProfileFields,
    load: boolean,
  ): Promise<{ saved: boolean; path?: string }>;
  key(code: string, down: boolean): void;
  releaseInput(): void;
  modal(open: boolean): void;
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields?: Record<string, unknown>,
  ): void;
}
