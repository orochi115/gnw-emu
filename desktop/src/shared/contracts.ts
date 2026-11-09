import type { ProfileFields } from "../core/schemas";
export type AppStatus = "idle" | "starting" | "running" | "stopping" | "error";
export interface AppState {
  status: AppStatus;
  stage?: string;
  runtimeSessionId?: string;
  profileName?: string;
  profilePath?: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  saveUncertain?: boolean;
}
export interface DesktopApi {
  locale(): Promise<"zh-CN" | "en">;
  state(): Promise<AppState>;
  onState(callback: (state: AppState) => void): () => void;
  openRom(): Promise<void>;
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
