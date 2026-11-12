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
import { prepareSession, type Session } from "./session-store";
import { acquireLease } from "./session-lease";
import { loadSettings } from "./settings-store";
import { QmpClient } from "./qmp-client";
import { InputController } from "./input-controller";
import {
  KernelBackend,
  preflightKernel,
  kernelArguments,
  kernelEnvironment,
  finishKernelSession,
  type KernelKind,
  verifyKernelIdentity,
} from "./kernel-backend";
import {
  saveSlot,
  loadSlot,
  restoreWithRollback,
  RollbackError,
  stateSlotTimes,
  type StateIdentity,
} from "./savestate-store";
import type { ToastMessage } from "../shared/contracts";
import type { GwemuPowerSnapshot } from "./schemas";
export type DeviceAction =
  | "device.batteryDown"
  | "device.batteryUp"
  | "device.usb"
  | "device.batteryPresent"
  | "device.pause"
  | "device.resume"
  | "device.coldStart";
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
  identity: StateIdentity;
  uncertain: boolean;
  suppressRelease: boolean;
  id: string;
  session: Session;
  lease: Awaited<ReturnType<typeof acquireLease>>;
  qmp: QmpClient;
  display: DisplayEndpoint;
  child?: ChildProcess;
  exit?: Promise<number | null>;
  input: InputController;
  backend: KernelBackend;
  stateFile: string;
  stopping: boolean;
  powerWork: Promise<void>;
  deviceJobs: number;
  execution?: AppState["execution"];
}
export class SessionController extends EventEmitter {
  state: AppState = { status: "idle" };
  private runtime?: Runtime;
  private busy = false;
  private stateWork?: Promise<void>;
  private stateOwner?: object;
  private slot = 0;
  private stopPromise?: Promise<void>;
  private startup?: {
    cancelled: boolean;
    cancel: () => void;
    done: Promise<void>;
  };
  constructor(
    private options: {
      userData: string;
      qemu: string;
      kernel?: KernelKind;
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
    if (this.busy || this.stopPromise) throw new UserError("error.busy");
    this.busy = true;
    let finish!: () => void, cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = reject;
    });
    cancelled.catch(() => {});
    const attempt = {
      cancelled: false,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      cancel: () => {
        if (attempt.cancelled) return;
        attempt.cancelled = true;
        cancel(new UserError("error.startCancelled"));
      },
    };
    this.startup = attempt;
    const previousRuntime = this.runtime;
    if (previousRuntime) this.publish({ ...this.state, deviceOperation: true });
    const check = () => {
      if (attempt.cancelled) throw new UserError("error.startCancelled");
    };
    try {
      // Register the cancellable attempt before waiting accepted snapshot work.
      await this.stateWork?.catch(() => {});
      check();
      // Validate all immutable inputs before stopping the old machine.
      const profile = await loadProfile(path);
      await access(this.options.qemu);
      const kernel = this.options.kernel ?? "legacy";
      const identity = await preflightKernel(
        kernel,
        profile,
        this.options.qemu,
      );
      check();
      await this.stopActiveRuntime();
      check();
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
      let transferred = false;
      try {
        const data =
          kernel === "gwemu"
            ? join(this.options.userData, "kernels", "gwemu")
            : this.options.userData;
        lease = await acquireLease(join(data, "leases", profile.id), id);
        const session = await prepareSession(profile, data, kernel);
        const runDir = join(session.directory, "runs", id);
        await mkdir(runDir, { recursive: true });
        const stateFile = join(runDir, "state.json");
        const settings = await loadSettings(this.options.userData);
        qmp = new QmpClient(
          this.options.logFor?.("qmp").child({ runtimeSessionId: id }),
        );
        const qmpPort = await qmp.listen();
        display = await this.options.createDisplay(id);
        const backend = new KernelBackend(kernel, qmp);
        const args = await kernelArguments(kernel, profile, session, settings, {
          qmpPort,
          framePort: display.port,
          stateFile,
        });
        check();
        const input = new InputController(
          async (mask) => {
            try {
              return await backend.buttons(mask);
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
          identity,
          uncertain: false,
          suppressRelease: false,
          id,
          session,
          lease,
          qmp,
          display,
          input,
          backend,
          stateFile,
          stopping: false,
          powerWork: Promise.resolve(),
          deviceJobs: 0,
        };
        this.runtime = runtime;
        const checkRuntime = () => {
          check();
          if (this.runtime !== runtime || runtime.stopping)
            throw new UserError("error.startCancelled");
        };
        transferred = true;
        await verifyKernelIdentity(this.options.qemu, identity);
        checkRuntime();
        const child = spawn(this.options.qemu, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: kernelEnvironment(kernel),
        });
        runtime.child = child;
        runtime.exit = new Promise((r, j) => {
          child.once("error", j);
          child.once("exit", (code) => r(code));
        });
        runtime.exit.catch(() => {});
        if (child.pid) await lease.attach(child.pid);
        check();
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
            cancelled,
          ]),
          this.options.timeout ?? 10000,
          "connect",
        );
        checkRuntime();
        if (kernel === "legacy") await backend.resetInput();
        checkRuntime();
        let deviceState =
          kernel === "gwemu" ? await backend.readDeviceState() : undefined;
        checkRuntime();
        if (!deviceState || deviceState.devicePower.powered) {
          const frame = display.waitForFrame();
          await qmp.command("cont");
          checkRuntime();
          // Standard QMP input rejects events while the VM is paused.
          if (kernel === "gwemu") await backend.resetInput();
          checkRuntime();
          this.publish({ ...this.state, stage: "start" });
          await deadline(
            Promise.race([frame, startupFailure, cancelled]),
            this.options.timeout ?? 10000,
            "frame",
          );
          if (kernel === "gwemu") deviceState = await backend.readDeviceState();
        }
        checkRuntime();
        runtime.execution = deviceState?.execution;
        const slots = await stateSlotTimes(session.directory, identity);
        const support = await qmp.command("qom-get", {
          path: "/machine",
          property: "savestate-support",
        });
        checkRuntime();
        this.slot = 0;
        this.publish({
          ...this.state,
          status: "running",
          stage: undefined,
          stateSlot: this.slot,
          canInstantState: support === "",
          deviceOperation: false,
          stateSlots: slots,
          ...deviceState,
        });
      } catch (error) {
        if (transferred) await this.stopActiveRuntime().catch(() => {});
        else {
          await qmp?.close();
          await display?.close();
          await lease?.release();
        }
        if (attempt.cancelled) {
          if (this.state.saveUncertain)
            throw new UserError("error.saveUncertain");
          this.publish({ status: "idle" });
          throw new UserError("error.startCancelled");
        }
        this.publish({ status: "error", ...errorState(error) });
        throw error;
      }
    } finally {
      this.busy = false;
      if (this.startup === attempt) {
        if (
          this.runtime === previousRuntime &&
          previousRuntime &&
          !previousRuntime.stopping
        )
          this.publish({
            ...this.state,
            deviceOperation: previousRuntime.deviceJobs > 0,
          });
        this.startup = undefined;
      }
      finish();
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
    if (!runtime || !this.canInput(runtime)) return;
    this.options
      .logFor?.("input")
      .debug(
        { event: "key", runtimeSessionId: runtime.id, code, down },
        "Device key",
      );
    runtime.input.key(code, down);
    if (!down) this.releasePhysicalInput();
  }
  private async deviceShortcut(runtime: Runtime, code: string) {
    const qmp = runtime.qmp;
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
  private hostOnlyRelease(runtime: Runtime) {
    return (
      runtime.backend.kind === "gwemu" &&
      (runtime.execution !== "running" ||
        runtime.suppressRelease ||
        !!this.stateOwner ||
        !!this.startup ||
        runtime.stopping ||
        runtime.uncertain)
    );
  }
  releaseInput() {
    const runtime = this.runtime;
    if (!runtime) return;
    if (this.hostOnlyRelease(runtime)) {
      runtime.input.resetHost();
      if (runtime.execution === "running") runtime.backend.deferHostRelease();
      else runtime.backend.resetHostInput();
    } else runtime.input.releaseAll();
  }
  /** An explicit physical key-up can settle held input after an early refusal. */
  releasePhysicalInput() {
    const runtime = this.runtime;
    if (runtime && this.canInput(runtime) && runtime.backend.hasPendingRelease)
      runtime.input.synchronize();
  }
  async flushInput() {
    await this.runtime?.input.flush();
  }
  async deviceAction(action: DeviceAction) {
    if (
      !this.runtime ||
      this.runtime.stopping ||
      this.state.status !== "running" ||
      this.stateWork ||
      this.stateOwner ||
      this.runtime.uncertain ||
      this.busy
    )
      return;
    const runtime = this.runtime;
    const executionAction = [
      "device.pause",
      "device.resume",
      "device.coldStart",
    ].includes(action);
    if (
      runtime.backend.kind === "legacy" &&
      !["device.batteryDown", "device.batteryUp", "device.usb"].includes(action)
    )
      return;
    runtime.deviceJobs++;
    if (runtime.backend.kind === "gwemu")
      this.publish({ ...this.state, deviceOperation: true });
    const work = runtime.powerWork
      .then(async () => {
        if (this.runtime !== runtime || (runtime.stopping && executionAction))
          return;
        if (runtime.backend.kind === "legacy") {
          await this.deviceShortcut(
            runtime,
            action === "device.usb"
              ? "KeyC"
              : action === "device.batteryDown"
                ? "Minus"
                : "Equal",
          );
          return;
        }
        try {
          const current = await runtime.backend.readDeviceState();
          runtime.execution = current.execution;
          if (runtime.stopping && executionAction) return;
          if (current.execution === "running") {
            runtime.input.releaseAll();
            await runtime.input.flush();
          }
          if (runtime.stopping && executionAction) return;
          if (action === "device.pause") {
            await runtime.qmp.command("stop");
          } else if (
            action === "device.resume" ||
            action === "device.coldStart"
          ) {
            if (!current.devicePower.powered)
              throw new Error("No power supply");
            if (action === "device.coldStart") {
              await runtime.qmp.command("stop");
              runtime.execution = "paused";
              await runtime.backend.coldReset();
            }
            if (runtime.stopping) return;
            await runtime.qmp.command("cont");
            runtime.input.resetHost();
            runtime.backend.resetHostInput();
          } else {
            const property =
              action === "device.usb"
                ? "usb-power"
                : action === "device.batteryPresent"
                  ? "battery-present"
                  : "battery";
            const value =
              property === "usb-power"
                ? !current.devicePower.usbPower
                : property === "battery-present"
                  ? !current.devicePower.batteryPresent
                  : Math.min(
                      100,
                      Math.max(
                        0,
                        current.devicePower.battery +
                          (action === "device.batteryDown" ? -10 : 10),
                      ),
                    );
            await runtime.qmp.command("qom-set", {
              path: "/machine",
              property,
              value,
            });
          }
        } finally {
          try {
            const value = await runtime.backend.readDeviceState();
            runtime.execution = value.execution;
            if (this.runtime === runtime && !runtime.stopping)
              this.publish({ ...this.state, ...value });
          } catch (error) {
            runtime.execution = "unknown";
            if (this.runtime === runtime && !runtime.stopping)
              this.publish({
                ...this.state,
                execution: "unknown",
                devicePower: undefined,
              });
            throw error;
          }
        }
      })
      .finally(() => {
        runtime.deviceJobs--;
        if (
          runtime.backend.kind === "gwemu" &&
          this.runtime === runtime &&
          !runtime.stopping
        )
          this.publish({
            ...this.state,
            deviceOperation: runtime.deviceJobs > 0,
          });
      });
    runtime.powerWork = work.catch(() => {});
    await work;
  }
  private canInput(runtime: Runtime) {
    return (
      this.state.status === "running" &&
      !this.stateWork &&
      !this.stateOwner &&
      !this.startup &&
      !runtime.uncertain &&
      !runtime.stopping &&
      runtime.deviceJobs === 0 &&
      (runtime.backend.kind === "legacy" || runtime.execution === "running")
    );
  }
  button(bit: number, down: boolean, source: string, runtimeSessionId: string) {
    if (this.runtime?.id !== runtimeSessionId || !this.canInput(this.runtime))
      return;
    this.options
      .logFor?.("input")
      .debug(
        { event: "button", runtimeSessionId, bit, down, source },
        "Chassis input",
      );
    this.runtime.input.button(bit, down, source);
    if (!down) this.releasePhysicalInput();
  }
  releaseChassis(runtimeSessionId: string) {
    if (this.runtime?.id !== runtimeSessionId) return;
    if (this.hostOnlyRelease(this.runtime)) {
      this.releaseInput();
      return;
    }
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
    if (
      this.busy ||
      this.stateOwner ||
      this.stopPromise ||
      !this.runtime ||
      this.runtime.stopping ||
      this.runtime.deviceJobs ||
      this.runtime.uncertain ||
      this.state.status !== "running"
    )
      return;
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
    const runtime = this.runtime;
    if (
      this.busy ||
      this.stopPromise ||
      this.stateOwner ||
      !runtime ||
      runtime.stopping ||
      runtime.uncertain ||
      runtime.deviceJobs ||
      this.state.status !== "running"
    )
      return Promise.resolve();
    const owner = {},
      slot = this.slot;
    this.stateOwner = owner;
    runtime.suppressRelease = true;
    if (runtime.backend.kind === "gwemu") {
      runtime.input.resetHost();
      runtime.backend.deferHostRelease();
    }
    // Main/router callbacks run synchronously from publish. The gate is already closed.
    this.publish({ ...this.state, stateOperation: action });
    const work = this.performState(runtime, action, slot).finally(() => {
      if (this.stateOwner === owner) {
        this.stateOwner = undefined;
        this.stateWork = undefined;
        if (this.runtime === runtime)
          this.publish({ ...this.state, stateOperation: undefined });
      }
      runtime.suppressRelease = false;
    });
    this.stateWork = work;
    return work;
  }
  private uncertainState(runtime: Runtime) {
    runtime.uncertain = true;
    runtime.execution = "unknown";
    runtime.input.resetHost();
    runtime.backend.resetHostInput();
    if (this.runtime === runtime && !runtime.stopping)
      this.publish({
        ...this.state,
        status: "error",
        execution: "unknown",
        devicePower: undefined,
        canInstantState: false,
        saveUncertain: true,
        ...errorState(new UserError("state.recoveryFailed")),
      });
  }
  private async performState(
    runtime: Runtime,
    action: "save" | "load",
    slot: number,
  ) {
    let originallyRunning = false,
      paused = false;
    const gwemu = runtime.backend.kind === "gwemu";
    const active = () =>
      this.runtime === runtime && !runtime.stopping && !runtime.uncertain;
    const refresh = async () => {
      if (!gwemu) return true;
      try {
        const value = await runtime.backend.readDeviceState();
        runtime.execution = value.execution;
        if (this.runtime === runtime && !runtime.stopping)
          this.publish({ ...this.state, ...value });
        return value.devicePower.powered;
      } catch (error) {
        // A failed read after cont must close the native execution gate too.
        await runtime.qmp.command("stop").catch(() => {});
        this.uncertainState(runtime);
        throw error;
      }
    };
    try {
      const support = await runtime.qmp.command("qom-get", {
        path: "/machine",
        property: "savestate-support",
      });
      if (support !== "") {
        if (support === "sd" || support === "flash-size") {
          this.toast({
            code: support === "sd" ? "state.sd" : "state.flashSize",
            kind: "info",
            duration: 5000,
          });
          return;
        }
        throw new UserError("error.kernelBuild");
      }
      const path =
        action === "load"
          ? await loadSlot(runtime.session.directory, slot, runtime.identity)
          : undefined;
      this.toast({
        code: action === "save" ? "state.saving" : "state.loading",
        params: { slot },
        kind: "progress",
      });
      await runtime.input.flush();
      const status = await runtime.qmp.command("query-status");
      originallyRunning = status.running === true;
      if (originallyRunning) {
        if (gwemu) await runtime.backend.buttons(0);
        else {
          runtime.input.releaseAll();
          await runtime.input.flush();
        }
      }
      await runtime.qmp.command("stop");
      paused = true;
      if (gwemu) {
        runtime.execution = "paused";
        runtime.input.resetHost();
        runtime.backend.resetHostInput();
      }
      const call = (property: string, value: string) =>
        runtime.qmp.command(
          "qom-set",
          { path: "/machine", property, value },
          120000,
        );
      if (action === "save")
        await saveSlot(
          runtime.session.directory,
          slot,
          (p) => call("save-state", p),
          runtime.identity,
        );
      else
        await restoreWithRollback(
          runtime.session.directory,
          path!,
          (p) => call("save-state", p),
          (p) => call("load-state", p),
          runtime.identity,
        );
      if (gwemu) {
        runtime.input.resetHost();
        runtime.backend.resetHostInput();
      } else await runtime.backend.resetInput();
      const powered = await refresh();
      const slots = await stateSlotTimes(
        runtime.session.directory,
        runtime.identity,
      );
      if (this.runtime === runtime && !runtime.stopping)
        this.publish({ ...this.state, stateSlots: slots });
      if (originallyRunning && powered && active()) {
        await runtime.qmp.command("cont");
        originallyRunning = false;
        if (gwemu) await refresh();
      }
      if (this.runtime === runtime)
        this.toast({
          code: action === "save" ? "state.saved" : "state.loaded",
          params: { slot },
          kind: "success",
          duration: 3000,
        });
    } catch (error) {
      if (error instanceof RollbackError) this.uncertainState(runtime);
      this.options.logger.error(
        { err: error, event: "savestate.failure", action, slot },
        "Instant state failed",
      );
      this.toast({
        code:
          error instanceof RollbackError
            ? "state.recoveryFailed"
            : error instanceof UserError
              ? error.code
              : "state.failed",
        params:
          error instanceof UserError ? error.params : { detail: String(error) },
        kind: "error",
      });
    } finally {
      if (paused && originallyRunning && active()) {
        try {
          if ((await refresh()) && active()) {
            await runtime.qmp.command("cont");
            if (gwemu) await refresh();
          }
        } catch {
          this.uncertainState(runtime);
        }
      }
    }
  }
  stop(): Promise<void> {
    const startup = this.startup;
    startup?.cancel();
    return this.stopActiveRuntime().finally(() => startup?.done);
  }
  private stopActiveRuntime(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.runtime) return Promise.resolve();
    // Close the execution gate before any queued action can reach cont.
    this.runtime.stopping = true;
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
    if (
      this.busy ||
      this.stateOwner ||
      runtime.stopping ||
      runtime.uncertain ||
      this.state.status !== "running"
    )
      throw new UserError("error.busy");
    await runtime.backend.setMuted(muted);
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
    let power: GwemuPowerSnapshot | undefined;
    let powerError: Error | undefined;
    try {
      if (
        runtime.child &&
        runtime.child.exitCode === null &&
        runtime.child.signalCode === null
      ) {
        try {
          await deadline(runtime.powerWork, 5000, "power");
          if (
            runtime.backend.kind === "legacy" ||
            runtime.execution === "running"
          ) {
            runtime.input.releaseAll();
            await deadline(runtime.input.flush(), 1000, "release").catch(
              () => {},
            );
          }
          if (runtime.backend.kind === "gwemu")
            power = await runtime.backend.snapshotPower();
        } catch {
          // Snapshot failure must not bypass child shutdown or claim a save.
          powerError = new UserError("error.saveUncertain");
        }
        await runtime.qmp.command("quit", undefined, 1000).catch(() => {});
        try {
          await deadline(runtime.exit!, 5000, "quit");
        } catch (e) {
          runtime.child.kill("SIGKILL");
          await deadline(runtime.exit!, 3000, "kill");
          throw new UserError("error.saveUncertain");
        }
      }
      if (powerError || runtime.uncertain)
        throw new UserError("error.saveUncertain");
      if (runtime.child) {
        await finishKernelSession(
          runtime.backend.kind,
          runtime.session,
          runtime.stateFile,
          runtime.child.exitCode,
          power,
        );
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
