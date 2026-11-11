import { UserError, errorState } from "../shared/user-error";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { DisplayEndpoint } from "../display/receiver";
import type { AppState, InputState } from "../shared/contracts";
import { loadProfile } from "./profile-store";
import { prepareSession, saveSession, type Session } from "./session-store";
import { acquireLease } from "./session-lease";
import { loadSettings } from "./settings-store";
import { QmpClient } from "./qmp-client";
import { InputController } from "./input-controller";
import { qemuArguments } from "./qemu-command";
import { readJson } from "./atomic-file";
import {
  saveSlot,
  loadSlot,
  restoreWithRollback,
  RollbackError,
  stateSlotTimes,
} from "./savestate-store";
import type { ToastMessage } from "../shared/contracts";
import { exitStateSchema } from "./schemas";
export async function deadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_r, j) => {
        timer = setTimeout(
          () => j(new UserError("error.timeout", { action: label })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
interface Runtime {
  audioMuted: boolean;
  id: string;
  session: Session;
  lease: Awaited<ReturnType<typeof acquireLease>>;
  qmp: QmpClient;
  display: DisplayEndpoint;
  child?: ChildProcess;
  exit?: Promise<number | null>;
  input: InputController;
  stateFile: string;
  stopping: boolean;
}
export class SessionController extends EventEmitter {
  state: AppState = { status: "idle" };
  private runtime?: Runtime;
  private busy = false;
  private stateWork?: Promise<void>;
  private slot = 0;
  private stopPromise?: Promise<void>;
  constructor(
    private options: {
      userData: string;
      qemu: string;
      logger: Logger;
      logFor?: (module: string) => Logger;
      createDisplay: (id: string) => Promise<DisplayEndpoint>;
      timeout?: number;
    },
  ) {
    super();
  }
  private publish(update: AppState) {
    this.state = update;
    this.options.logger.info({ event: "state", ...update }, "Session state");
    this.emit("state", update);
  }
  async load(path: string) {
    if (this.busy) throw new UserError("error.busy");
    this.busy = true;
    try {
      // Validate all immutable inputs before stopping the old machine.
      const profile = await loadProfile(path);
      await access(this.options.qemu);
      await this.stop();
      const id = randomUUID();
      this.publish({
        status: "starting",
        stage: "prepare",
        runtimeSessionId: id,
        profileName: basename(path, ".gnw.json"),
        profilePath: path,
        model: profile.model,
      });
      let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
      let qmp: QmpClient | undefined;
      let display: DisplayEndpoint | undefined;
      try {
        lease = await acquireLease(
          join(this.options.userData, "leases", profile.id),
          id,
        );
        const session = await prepareSession(profile, this.options.userData);
        const runDir = join(session.directory, "runs", id);
        await mkdir(runDir, { recursive: true });
        const stateFile = join(runDir, "state.json");
        const settings = await loadSettings(this.options.userData);
        qmp = new QmpClient(
          this.options.logFor?.("qmp").child({ runtimeSessionId: id }),
        );
        const qmpPort = await qmp.listen();
        display = await this.options.createDisplay(id);
        const input = new InputController(
          async (mask) => {
            try {
              return await qmp!.command("qom-set", {
                path: "/machine",
                property: "buttons",
                value: mask,
              });
            } catch (error) {
              this.options.logFor?.("input").error(
                {
                  event: "submit.failure",
                  err: error,
                  runtimeSessionId: id,
                  mask,
                },
                "Input submission failed",
              );
              throw error;
            }
          },
          (snapshot) => {
            if (this.runtime?.id !== id) return;
            this.options
              .logFor?.("input")
              .debug(
                { event: "mask", runtimeSessionId: id, ...snapshot },
                "Input state",
              );
            this.emit("input", { runtimeSessionId: id, ...snapshot });
          },
        );
        const runtime: Runtime = {
          audioMuted: !settings.audio,
          id,
          session,
          lease,
          qmp,
          display,
          input,
          stateFile,
          stopping: false,
        };
        this.runtime = runtime;
        const child = spawn(
          this.options.qemu,
          qemuArguments(profile, session, settings, {
            qmpPort,
            framePort: display.port,
            stateFile,
          }),
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        runtime.child = child;
        runtime.exit = new Promise((r, j) => {
          child.once("error", j);
          child.once("exit", (code) => r(code));
        });
        runtime.exit.catch(() => {});
        if (child.pid) await lease.attach(child.pid);
        let stderr = "";
        child.stderr!.on("data", (chunk) => {
          stderr = (stderr + chunk.toString()).slice(-8192);
          this.options.logger.info(
            {
              event: "output",
              source: "qemu",
              runtimeSessionId: id,
              text: chunk.toString().slice(0, 8192),
            },
            "QEMU output",
          );
        });
        const startupFailure = runtime.exit.then((code) => {
          throw new UserError("error.startup", {
            code: code ?? "signal",
            detail: stderr,
          });
        });
        qmp.on("disconnect", () => {
          if (
            this.runtime?.id === id &&
            !runtime.stopping &&
            this.state.status === "running"
          )
            void this.failed(new UserError("error.controlDisconnected"));
        });
        display.events.on("failure", (error) => {
          if (
            this.runtime?.id === id &&
            !runtime.stopping &&
            this.state.status === "running"
          )
            void this.failed(error);
        });
        child.once("exit", (code) => {
          if (
            this.runtime?.id === id &&
            !runtime.stopping &&
            this.state.status === "running"
          )
            void this.failed(
              new UserError("error.exited", { code: code ?? "signal" }),
            );
        });
        this.publish({ ...this.state, stage: "connect" });
        await deadline(
          Promise.race([
            Promise.all([qmp.ready, display.ready]),
            startupFailure,
          ]),
          this.options.timeout ?? 10000,
          "connect",
        );
        await qmp.command("qom-set", {
          path: "/machine",
          property: "buttons",
          value: 0,
        });
        const frame = display.waitForFrame();
        await qmp.command("cont");
        this.publish({ ...this.state, stage: "start" });
        await deadline(
          Promise.race([frame, startupFailure]),
          this.options.timeout ?? 10000,
          "frame",
        );
        this.slot = 0;
        this.publish({
          ...this.state,
          status: "running",
          stage: undefined,
          stateSlot: this.slot,
          stateSlots: await stateSlotTimes(session.directory),
        });
      } catch (error) {
        if (this.runtime) await this.stop().catch(() => {});
        else {
          await qmp?.close();
          await display?.close();
          await lease?.release();
        }
        this.publish({ status: "error", ...errorState(error) });
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }
  private async failed(error: Error) {
    this.options.logger.error(
      { err: error, event: "failure", runtimeSessionId: this.runtime?.id },
      "Session failed",
    );
    await this.stop().catch(() => {});
    this.publish({
      status: "error",
      ...errorState(error),
      saveUncertain: true,
    });
  }
  key(code: string, down: boolean) {
    const runtime = this.runtime;
    if (!runtime || this.state.status !== "running" || this.stateWork) return;
    this.options
      .logFor?.("input")
      .debug(
        { event: "key", runtimeSessionId: runtime.id, code, down },
        "Device key",
      );
    runtime.input.key(code, down);
  }
  private async deviceShortcut(code: string) {
    const qmp = this.runtime!.qmp;
    const property = code === "KeyC" ? "usb-power" : "battery";
    const value = await qmp.command("qom-get", { path: "/machine", property });
    await qmp.command("qom-set", {
      path: "/machine",
      property,
      value:
        code === "KeyC"
          ? !value
          : Math.min(100, Math.max(0, value + (code === "Minus" ? -10 : 10))),
    });
  }
  releaseInput() {
    this.runtime?.input.releaseAll();
  }
  async flushInput() {
    await this.runtime?.input.flush();
  }
  async deviceAction(
    action: "device.batteryDown" | "device.batteryUp" | "device.usb",
  ) {
    if (!this.runtime || this.state.status !== "running" || this.stateWork)
      return;
    await this.deviceShortcut(
      action === "device.usb"
        ? "KeyC"
        : action === "device.batteryDown"
          ? "Minus"
          : "Equal",
    );
  }
  button(bit: number, down: boolean, source: string, runtimeSessionId: string) {
    if (
      this.runtime?.id !== runtimeSessionId ||
      this.state.status !== "running" ||
      this.stateWork
    )
      return;
    this.options
      .logFor?.("input")
      .debug(
        { event: "button", runtimeSessionId, bit, down, source },
        "Chassis input",
      );
    this.runtime.input.button(bit, down, source);
  }
  releaseChassis(runtimeSessionId: string) {
    if (this.runtime?.id !== runtimeSessionId) return;
    this.runtime.input.releaseSources("pointer:");
    this.runtime.input.releaseSources("chassis-key:");
  }
  inputState(): InputState {
    return {
      runtimeSessionId: this.runtime?.id,
      ...(this.runtime?.input.snapshot ?? {
        desiredMask: 0,
        appliedMask: 0,
        resetGeneration: 0,
      }),
    };
  }
  async probe(filename: string) {
    if (!this.runtime || this.state.status !== "running")
      throw new Error("No running emulator");
    const qmp = this.runtime.qmp;
    await qmp.command("screendump", { filename, format: "png" });
    return {
      registers: await qmp.command("human-monitor-command", {
        "command-line": "info registers",
      }),
      ...this.diagnostics(),
    };
  }
  diagnostics() {
    return {
      audioMuted: this.runtime?.audioMuted,
      ...this.runtime?.display.diagnostics(),
      buttons: this.runtime?.input.buttons ?? 0,
      input: this.inputState(),
      qemuPid: this.runtime?.child?.pid,
      runtimeSessionId: this.runtime?.id,
    };
  }
  selectStateSlot(slot: number) {
    if (this.busy || !this.runtime || this.state.status !== "running") return;
    if (!Number.isInteger(slot) || slot < 0 || slot > 9)
      throw new Error("Invalid state slot");
    this.slot = slot;
    this.publish({ ...this.state, stateSlot: slot });
    this.toast({
      code: "state.selected",
      params: { slot },
      kind: "info",
      duration: 3000,
    });
  }
  private toast(message: ToastMessage) {
    this.emit("toast", message);
  }
  instantState(action: "save" | "load"): Promise<void> {
    if (
      this.busy ||
      this.stopPromise ||
      !this.runtime ||
      this.state.status !== "running"
    )
      return Promise.resolve();
    this.busy = true;
    const runtime = this.runtime,
      slot = this.slot;
    const work = this.performState(runtime, action, slot).finally(() => {
      this.busy = false;
      this.stateWork = undefined;
      this.publish({ ...this.state, stateOperation: undefined });
    });
    this.stateWork = work;
    return work;
  }
  private async performState(
    runtime: Runtime,
    action: "save" | "load",
    slot: number,
  ) {
    let resume = false;
    try {
      const support = await runtime.qmp.command("qom-get", {
        path: "/machine",
        property: "savestate-support",
      });
      if (support) {
        this.toast({
          code: support === "sd" ? "state.sd" : "state.flashSize",
          kind: "info",
          duration: 5000,
        });
        return;
      }
      const path =
        action === "load"
          ? await loadSlot(runtime.session.directory, slot)
          : undefined;
      this.publish({ ...this.state, stateOperation: action });
      this.toast({
        code: action === "save" ? "state.saving" : "state.loading",
        params: { slot },
        kind: "progress",
      });
      runtime.input.releaseAll();
      await runtime.input.flush();
      const status = await runtime.qmp.command("query-status");
      await runtime.qmp.command("stop");
      resume = status.running;
      const call = (property: string, value: string) =>
        runtime.qmp.command(
          "qom-set",
          { path: "/machine", property, value },
          120000,
        );
      if (action === "save")
        await saveSlot(runtime.session.directory, slot, (p) =>
          call("save-state", p),
        );
      else
        await restoreWithRollback(
          runtime.session.directory,
          path!,
          (p) => call("save-state", p),
          (p) => call("load-state", p),
        );
      this.publish({
        ...this.state,
        stateSlots: await stateSlotTimes(runtime.session.directory),
      });
      await runtime.qmp.command("qom-set", {
        path: "/machine",
        property: "buttons",
        value: 0,
      });
      if (resume) {
        await runtime.qmp.command("cont");
        resume = false;
      }
      this.toast({
        code: action === "save" ? "state.saved" : "state.loaded",
        params: { slot },
        kind: "success",
        duration: 3000,
      });
    } catch (error) {
      if (error instanceof RollbackError) {
        resume = false;
        this.publish({
          ...this.state,
          status: "error",
          ...errorState(new UserError("state.recoveryFailed")),
        });
      }
      this.options.logger.error(
        { err: error, event: "savestate.failure", action, slot },
        "Instant state failed",
      );
      this.toast({
        code: error instanceof UserError ? error.code : "state.failed",
        params:
          error instanceof UserError ? error.params : { detail: String(error) },
        kind: "error",
      });
    } finally {
      if (resume) await runtime.qmp.command("cont").catch(() => {});
    }
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.runtime) return Promise.resolve();
    this.stopPromise = (this.stateWork ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.stopRuntime())
      .finally(() => {
        this.stopPromise = undefined;
      });
    return this.stopPromise;
  }
  async setMuted(muted: boolean) {
    const runtime = this.runtime;
    if (!runtime) return;
    if (this.busy || this.state.status !== "running")
      throw new UserError("error.busy");
    await runtime.qmp.command("qom-set", {
      path: "/machine",
      property: "audio-muted",
      value: muted,
    });
    runtime.audioMuted = muted;
  }
  private async stopRuntime() {
    const runtime = this.runtime!;
    runtime.stopping = true;
    this.publish({
      ...this.state,
      status: "stopping",
      stage: "stop",
    });
    let error: Error | undefined;
    try {
      runtime.input.releaseAll();
      await deadline(runtime.input.flush(), 1000, "release").catch(() => {});
      if (
        runtime.child &&
        runtime.child.exitCode === null &&
        runtime.child.signalCode === null
      ) {
        await runtime.qmp.command("quit", undefined, 1000).catch(() => {});
        try {
          await deadline(runtime.exit!, 5000, "quit");
        } catch (e) {
          runtime.child.kill("SIGKILL");
          await deadline(runtime.exit!, 3000, "kill");
          throw new UserError("error.saveUncertain");
        }
      }
      if (runtime.child) {
        const state = exitStateSchema.parse(await readJson(runtime.stateFile));
        await saveSession(runtime.session, state);
      }
    } catch (e) {
      error = e as Error;
    } finally {
      await runtime.qmp.close();
      await runtime.display.close();
      const childAlive =
        runtime.child &&
        runtime.child.exitCode === null &&
        runtime.child.signalCode === null;
      if (!childAlive) await runtime.lease.release();
      if (this.runtime?.id === runtime.id) this.runtime = undefined;
    }
    if (error) {
      this.publish({
        status: "error",
        ...errorState(error),
        saveUncertain: true,
      });
      throw error;
    }
    this.publish({ status: "idle" });
  }
}
