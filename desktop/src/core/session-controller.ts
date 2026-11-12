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
import {
  openManagerDirectory,
  type OwnedManagerEndpoint,
} from "./manager-endpoints";
import {
  ManagerProtocolError,
  parseControl,
  parseCompletion,
  type ManagerCompletion,
  type ManagerControl,
  type ManagerMutations,
  type ManagerOperation,
  type ManagerSessionDescriptor,
} from "./manager-protocol";

export interface ManagerOwner {
  readonly operation: ManagerOperation;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export interface ManagerAcquisition {
  sessionId: string;
  /** Internal native endpoint. The server exposes only its lease-owned proxy. */
  gdbEndpoint: string;
  initial: {
    execution: NonNullable<AppState["execution"]>;
    devicePower: NonNullable<AppState["devicePower"]>;
  };
}
interface ManagerContext {
  owner: ManagerOwner;
  operation: ManagerOperation;
  runtime: Runtime;
  deadline: number;
  abort: AbortController;
  onAbort: () => void;
  timer: NodeJS.Timeout;
  closing: boolean;
  admitted: boolean;
  failed: boolean;
  mutationGeneration: number;
  applicationControls: number;
  applicationReady: boolean;
  mutations: ManagerMutations;
  intent?: "paused" | "running";
  initial?: ManagerAcquisition["initial"];
  ready: Promise<void>;
  work: Promise<unknown>;
  finish?: Promise<{ session: ManagerSessionDescriptor }>;
}
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
  gdbEndpoint?: OwnedManagerEndpoint;
  gdbReady?: Promise<void>;
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
  private manager?: ManagerContext;
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
      managerDirectory?: string;
      /** Disable native GDB for accelerators without guest debugging (e.g. qtest). */
      enableManager?: boolean;
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
    if (this.busy || this.stopPromise || this.manager)
      throw new UserError("error.busy");
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
      let gdbEndpoint: OwnedManagerEndpoint | undefined;
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
        if (
          kernel === "gwemu" &&
          process.platform !== "win32" &&
          this.options.enableManager !== false
        ) {
          const directory = await openManagerDirectory({
            directory: this.options.managerDirectory,
          });
          gdbEndpoint = await directory.socket("native");
          check();
        }
        const args = await kernelArguments(kernel, profile, session, settings, {
          qmpPort,
          framePort: display.port,
          stateFile,
          gdbSocket: gdbEndpoint?.path,
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
          gdbEndpoint,
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
        if (gdbEndpoint) {
          // Claim the native socket independently of display/QMP readiness, even
          // when the child exits immediately after bind. Cleanup awaits this task.
          runtime.gdbReady = this.claimNativeEndpoint(runtime, gdbEndpoint);
          runtime.gdbReady.catch(() => {});
        }
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
            Promise.all([qmp.ready, display.ready, runtime.gdbReady]),
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
          await gdbEndpoint?.close();
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
  private async claimNativeEndpoint(
    runtime: Runtime,
    endpoint: OwnedManagerEndpoint,
  ) {
    const until = performance.now() + (this.options.timeout ?? 10000);
    for (;;) {
      try {
        await endpoint.secure();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (
          runtime.child?.exitCode !== null ||
          runtime.child?.signalCode !== null
        )
          throw new UserError("error.startup", {
            code: "signal",
            detail: "Native GDB endpoint was not bound",
          });
        if (performance.now() >= until)
          throw new UserError("error.timeout", { action: "native-gdb" });
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    }
  }
  managerSession(): ManagerSessionDescriptor | undefined {
    const runtime = this.runtime;
    if (
      !runtime ||
      runtime.backend.kind !== "gwemu" ||
      runtime.stopping ||
      !runtime.child ||
      runtime.child.exitCode !== null ||
      runtime.child.signalCode !== null ||
      this.state.status === "starting"
    )
      return;
    return {
      sessionId: runtime.id,
      profileName: this.state.profileName ?? "Game & Watch",
      model: this.state.model ?? "mario",
      kernel: "gwemu",
      execution: runtime.uncertain
        ? "unknown"
        : (runtime.execution ?? "unknown"),
      powered: this.state.devicePower?.powered ?? false,
      capabilities: runtime.gdbEndpoint
        ? ["manage", "gdb", "backup", "device-control"]
        : [],
    };
  }
  private managerCheck(context: ManagerContext, closing = false) {
    if (
      this.manager !== context ||
      this.runtime !== context.runtime ||
      context.runtime.stopping
    )
      throw new ManagerProtocolError(
        "STALE_SESSION",
        "Managed session is no longer active",
      );
    if (
      !closing &&
      (context.closing ||
        context.abort.signal.aborted ||
        performance.now() >= context.deadline)
    )
      throw new ManagerProtocolError("LEASE_EXPIRED", "Management lease ended");
  }
  private managerContext(owner: ManagerOwner) {
    const context = this.manager;
    if (!context || context.owner !== owner)
      throw new ManagerProtocolError(
        "NOT_OWNER",
        "Management owner does not match",
      );
    this.managerCheck(context);
    if (!context.admitted)
      throw new ManagerProtocolError("BUSY", "Management admission is pending");
    return context;
  }
  private managerBudget(context: ManagerContext) {
    this.managerCheck(context);
    return Math.max(
      1,
      Math.min(5000, Math.ceil(context.deadline - performance.now())),
    );
  }
  private async managerAwait<T>(
    context: ManagerContext,
    work: Promise<T>,
  ): Promise<T> {
    this.managerCheck(context);
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () =>
        reject(
          new ManagerProtocolError("LEASE_EXPIRED", "Management lease ended"),
        );
      context.abort.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const result = await Promise.race([work, aborted]);
      this.managerCheck(context);
      return result;
    } finally {
      context.abort.signal.removeEventListener("abort", cancel);
    }
  }
  private managerCommand(
    context: ManagerContext,
    name: string,
    args?: Record<string, unknown>,
  ) {
    return this.managerAwait(
      context,
      context.runtime.qmp.command(name, args, this.managerBudget(context)),
    );
  }
  private async managerRead(context: ManagerContext) {
    const value = await this.managerAwait(
      context,
      context.runtime.backend.readDeviceState(this.managerBudget(context)),
    );
    context.runtime.execution = value.execution;
    this.publish({ ...this.state, ...value, deviceOperation: true });
    return value;
  }
  beginManager(
    sessionId: string,
    owner: ManagerOwner,
  ): Promise<ManagerAcquisition> {
    const runtime = this.runtime;
    if (
      !runtime ||
      runtime.id !== sessionId ||
      runtime.stopping ||
      !this.managerSession()
    )
      return Promise.reject(
        new ManagerProtocolError(
          "STALE_SESSION",
          "Session is no longer active",
        ),
      );
    if (runtime.uncertain)
      return Promise.reject(
        new ManagerProtocolError(
          "UNCERTAIN",
          "Close and reopen the uncertain session",
        ),
      );
    if (this.manager || this.busy || this.startup || this.stopPromise)
      return Promise.reject(
        new ManagerProtocolError("BUSY", "Session is busy"),
      );
    if (!runtime.gdbEndpoint)
      return Promise.reject(
        new ManagerProtocolError(
          "UNSUPPORTED",
          "Current-session management requires a private Unix endpoint",
        ),
      );
    if (
      !owner ||
      !["read", "manage", "debug"].includes(owner.operation) ||
      !Number.isFinite(owner.deadlineMs) ||
      owner.deadlineMs - Date.now() > 3600000 ||
      !(owner.signal instanceof AbortSignal)
    )
      return Promise.reject(
        new ManagerProtocolError("INVALID_REQUEST", "Invalid management owner"),
      );
    const duration = owner.deadlineMs - Date.now();
    if (duration <= 0 || owner.signal.aborted)
      return Promise.reject(
        new ManagerProtocolError("LEASE_EXPIRED", "Management lease ended"),
      );
    const accepted = Promise.all([
      runtime.powerWork,
      this.stateWork ?? Promise.resolve(),
    ]);
    const context: ManagerContext = {
      owner,
      operation: owner.operation,
      runtime,
      deadline: performance.now() + duration,
      abort: new AbortController(),
      closing: false,
      admitted: false,
      failed: false,
      mutationGeneration: 0,
      applicationControls: 0,
      applicationReady: owner.operation !== "debug",
      mutations: {
        managerUploaded: false,
        memoryWritten: false,
        executionChanged: false,
      },
      ready: Promise.resolve(),
      work: Promise.resolve(),
      timer: undefined as unknown as NodeJS.Timeout,
      onAbort: () => {
        context.abort.abort();
        void this.endManager(owner, {
          ...context.mutations,
          success: false,
        }).catch(() => {});
      },
    };
    // Owner and input gate are synchronous, before admission's first await.
    this.manager = context;
    owner.signal.addEventListener("abort", context.onAbort, { once: true });
    context.timer = setTimeout(context.onAbort, duration);
    runtime.input.resetHost();
    this.publish({ ...this.state, deviceOperation: true });
    context.ready = (async () => {
      await this.managerAwait(context, accepted);
      context.initial = await this.managerRead(context);
      await this.managerAwait(context, runtime.input.flush());
      await this.managerAwait(
        context,
        runtime.backend.releaseHostInput(this.managerBudget(context)),
      );
      await this.managerCommand(context, "stop");
      await this.managerRead(context);
      context.admitted = true;
    })();
    return context.ready
      .then(() => {
        this.managerCheck(context);
        return {
          sessionId: runtime.id,
          gdbEndpoint: runtime.gdbEndpoint!.path,
          initial: context.initial!,
        };
      })
      .catch(async (error) => {
        await this.endManager(owner, {
          ...context.mutations,
          success: false,
        }).catch(() => {});
        throw error;
      });
  }
  markManager(owner: ManagerOwner, flags: ManagerMutations) {
    const context = this.managerContext(owner);
    const validated = parseCompletion({ ...flags, success: true });
    const changesTarget =
      validated.managerUploaded ||
      validated.memoryWritten ||
      validated.executionChanged;
    // The caller must receive a successful mark before issuing GDB mutations.
    // Accepted application execution excludes a concurrent pre-mutation mark.
    if (changesTarget && context.applicationControls > 0)
      throw new ManagerProtocolError(
        "BUSY",
        "Wait for application execution control before mutating the target",
      );
    if (changesTarget) context.mutationGeneration++;
    for (const key of [
      "managerUploaded",
      "memoryWritten",
      "executionChanged",
    ] as const) {
      context.mutations[key] ||= validated[key];
      if (validated[key]) context.applicationReady = false;
    }
    return { session: this.managerSession()! };
  }
  managerControl(owner: ManagerOwner, action: ManagerControl) {
    let context: ManagerContext;
    let control: ManagerControl;
    try {
      context = this.managerContext(owner);
      control = parseControl(action);
      if (context.operation === "read")
        throw new ManagerProtocolError(
          "NOT_OWNER",
          "Read lease cannot control the device",
        );
    } catch (error) {
      return Promise.reject(error);
    }
    const executesApplication =
      control.action === "press" || control.action === "resume";
    if (executesApplication) context.applicationControls++;
    const work = context.work
      .catch(() => {})
      .then(() => this.performManagerControl(context, control))
      .catch((error) => {
        if (
          !(error instanceof ManagerProtocolError) ||
          !["NO_POWER", "TARGET_UNSAFE"].includes(error.code)
        ) {
          context.failed = true;
          void this.endManager(owner, {
            ...context.mutations,
            success: false,
          }).catch(() => {});
        }
        throw error;
      })
      .finally(() => {
        if (executesApplication) context.applicationControls--;
      });
    context.work = work;
    return work;
  }
  private async performManagerControl(
    context: ManagerContext,
    control: ManagerControl,
  ) {
    this.managerCheck(context);
    const runtime = context.runtime;
    const current = await this.managerRead(context);
    if (
      ["resume", "cold-start", "press"].includes(control.action) &&
      !current.devicePower.powered
    )
      throw new ManagerProtocolError("NO_POWER", "No power supply");
    if (
      (control.action === "resume" || control.action === "press") &&
      !context.applicationReady
    )
      throw new ManagerProtocolError(
        "TARGET_UNSAFE",
        "Reset to the application before executing it",
      );
    if (control.action === "pause") {
      await this.managerCommand(context, "stop");
      context.intent = "paused";
    } else if (control.action === "resume") {
      await this.managerCommand(context, "cont");
      context.intent = "running";
    } else if (
      control.action === "warm-reset" ||
      control.action === "cold-start"
    ) {
      await this.managerCommand(context, "stop");
      const resetGeneration = context.mutationGeneration;
      if (control.action === "cold-start") {
        await this.managerAwait(
          context,
          runtime.backend.coldReset(this.managerBudget(context)),
        );
      } else await this.managerCommand(context, "system_reset");
      await this.managerCommand(context, "stop");
      await this.managerCommand(context, "query-status");
      context.applicationReady = context.mutationGeneration === resetGeneration;
      context.intent = "paused";
      if (control.action === "cold-start") {
        if (!context.applicationReady)
          throw new ManagerProtocolError(
            "TARGET_UNSAFE",
            "Target changed after the reset",
          );
        context.applicationControls++;
        try {
          await this.managerCommand(context, "cont");
          context.intent = "running";
          const value = await this.managerRead(context);
          return {
            session: this.managerSession()!,
            devicePower: value.devicePower,
          };
        } finally {
          context.applicationControls--;
        }
      }
    } else if (control.action === "press") {
      try {
        await this.managerCommand(context, "cont");
        const status = (await this.managerCommand(context, "query-status")) as {
          running?: boolean;
        };
        if (status.running !== true)
          throw new ManagerProtocolError(
            "TARGET_UNSAFE",
            "Guest did not enter running state",
          );
        await this.managerAwait(
          context,
          runtime.backend.buttons(
            control.value.mask,
            this.managerBudget(context),
          ),
        );
        await this.managerDelay(context, control.value.durationMs);
        // Release while guest runs, then give it a bounded observation window.
        await this.managerAwait(
          context,
          runtime.backend.buttons(0, this.managerBudget(context)),
        );
        await this.managerDelay(context, 20);
        const releasedStatus = (await this.managerCommand(
          context,
          "query-status",
        )) as { running?: boolean };
        if (releasedStatus.running !== true)
          throw new ManagerProtocolError(
            "TARGET_UNSAFE",
            "Guest stopped before observing release",
          );
        await this.managerCommand(context, "stop");
      } finally {
        // Cleanup cannot continue a paused/unpowered/unknown guest for key-up.
        await this.cleanupManagerInput(context);
      }
    } else {
      await this.managerCommand(context, "qom-set", {
        path: "/machine",
        property: control.action,
        value: control.value,
      });
    }
    const value = await this.managerRead(context);
    return { session: this.managerSession()!, devicePower: value.devicePower };
  }
  private async managerDelay(context: ManagerContext, ms: number) {
    this.managerCheck(context);
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.managerAwait(
        context,
        new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private async cleanupManagerInput(context: ManagerContext) {
    if (
      this.runtime !== context.runtime ||
      this.manager !== context ||
      context.runtime.stopping
    )
      return;
    await context.runtime.qmp.command("stop", undefined, 1000);
    if (
      this.runtime !== context.runtime ||
      this.manager !== context ||
      context.runtime.stopping
    )
      return;
    await context.runtime.backend.releaseHostInput(1000);
  }
  private async managerFinishAwait<T>(
    context: ManagerContext,
    work: Promise<T>,
    allowExpired = false,
  ): Promise<T> {
    this.managerCheck(context, true);
    const value = await deadline(work, 1000, "manager-release");
    this.managerCheck(context, true);
    if (
      !allowExpired &&
      (context.owner.signal.aborted || performance.now() >= context.deadline)
    )
      throw new ManagerProtocolError(
        "LEASE_EXPIRED",
        "Management lease ended during release",
      );
    return value;
  }
  endManager(
    owner: ManagerOwner,
    result: ManagerCompletion,
  ): Promise<{ session: ManagerSessionDescriptor }> {
    const context = this.manager;
    if (!context || context.owner !== owner)
      return Promise.reject(
        new ManagerProtocolError(
          "NOT_OWNER",
          "Management owner does not match",
        ),
      );
    if (context.finish) return context.finish;
    let completion: ManagerCompletion;
    try {
      completion = parseCompletion(result);
    } catch (error) {
      return Promise.reject(error);
    }
    context.closing = true;
    const aborted =
      context.abort.signal.aborted ||
      performance.now() >= context.deadline ||
      owner.signal.aborted;
    context.abort.abort();
    clearTimeout(context.timer);
    owner.signal.removeEventListener("abort", context.onAbort);
    context.finish = (async () => {
      try {
        await context.ready.catch(() => {});
        this.managerCheck(context, true);
        await context.work.catch(() => {});
        this.managerCheck(context, true);
        if (this.runtime !== context.runtime || context.runtime.stopping)
          throw new ManagerProtocolError(
            "STALE_SESSION",
            "Managed session ended",
          );
        await this.managerFinishAwait(
          context,
          this.cleanupManagerInput(context),
          true,
        );
        if (
          !completion.success ||
          aborted ||
          owner.signal.aborted ||
          performance.now() >= context.deadline ||
          context.failed ||
          !context.admitted
        ) {
          this.uncertainState(context.runtime);
        } else {
          const changed =
            !context.applicationReady ||
            ["managerUploaded", "memoryWritten", "executionChanged"].some(
              (key) =>
                completion[key as keyof ManagerMutations] ||
                context.mutations[key as keyof ManagerMutations],
            );
          if (changed) {
            await this.managerFinishAwait(
              context,
              context.runtime.qmp.command("system_reset", undefined, 1000),
            );
            await this.managerFinishAwait(
              context,
              context.runtime.qmp.command("stop", undefined, 1000),
            );
            await this.managerFinishAwait(
              context,
              context.runtime.qmp.command("query-status", undefined, 1000),
            );
          }
          const value = await this.managerFinishAwait(
            context,
            context.runtime.backend.readDeviceState(1000),
          );
          const intent = context.intent ?? context.initial?.execution;
          if (value.devicePower.powered && intent === "running")
            await this.managerFinishAwait(
              context,
              context.runtime.qmp.command("cont", undefined, 1000),
            );
          const final = await this.managerFinishAwait(
            context,
            context.runtime.backend.readDeviceState(1000),
          );
          context.runtime.execution = final.execution;
          this.publish({ ...this.state, ...final });
        }
        return { session: this.managerSession()! };
      } catch (error) {
        // A post-cont read can fail too; close native execution before uncertainty.
        await this.cleanupManagerInput(context).catch(() => {});
        if (this.runtime === context.runtime && !context.runtime.stopping)
          this.uncertainState(context.runtime);
        throw error;
      } finally {
        if (this.manager === context) {
          this.manager = undefined;
          if (this.runtime === context.runtime && !context.runtime.stopping)
            this.publish({
              ...this.state,
              deviceOperation: context.runtime.deviceJobs > 0,
            });
        }
      }
    })();
    return context.finish;
  }
  private revokeManager(runtime: Runtime) {
    const context = this.manager;
    if (!context || context.runtime !== runtime) return;
    context.closing = true;
    context.abort.abort();
    clearTimeout(context.timer);
    context.owner.signal.removeEventListener("abort", context.onAbort);
    runtime.uncertain = true;
    this.emit("manager-revoke", {
      sessionId: runtime.id,
      owner: context.owner,
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
    if (this.manager) return;
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
      this.busy ||
      this.manager
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
        if (
          this.runtime !== runtime ||
          ((runtime.stopping || runtime.uncertain) && executionAction)
        )
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
          if (!runtime.uncertain) runtime.execution = current.execution;
          if ((runtime.stopping || runtime.uncertain) && executionAction)
            return;
          if (current.execution === "running") {
            runtime.input.releaseAll();
            await runtime.input.flush();
          }
          if ((runtime.stopping || runtime.uncertain) && executionAction)
            return;
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
            if (runtime.stopping || runtime.uncertain) return;
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
            if (!runtime.uncertain) runtime.execution = value.execution;
            if (
              this.runtime === runtime &&
              !runtime.stopping &&
              !runtime.uncertain
            )
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
            deviceOperation:
              runtime.deviceJobs > 0 || this.manager?.runtime === runtime,
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
      !this.manager &&
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
    if (this.manager) return;
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
      this.manager ||
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
      this.manager ||
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
        if (!runtime.uncertain) runtime.execution = value.execution;
        if (active()) this.publish({ ...this.state, ...value });
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
      if (active())
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
    this.revokeManager(this.runtime);
    const manager = this.manager;
    this.stopPromise = Promise.all([
      this.stateWork ?? Promise.resolve(),
      manager?.ready.catch(() => {}),
      manager?.work.catch(() => {}),
      manager?.finish?.catch(() => {}),
    ])
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
      this.manager ||
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
          if (runtime.backend.kind === "gwemu") {
            if (this.manager?.runtime === runtime)
              await runtime.backend.releaseHostInput(1000);
            power = await runtime.backend.snapshotPower();
          }
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
      await runtime.gdbReady?.catch(() => {});
      await runtime.gdbEndpoint?.close().catch((closeError) => {
        error ??= closeError as Error;
      });
      const childAlive =
        runtime.child &&
        runtime.child.exitCode === null &&
        runtime.child.signalCode === null;
      if (!childAlive) await runtime.lease.release();
      if (this.runtime?.id === runtime.id) this.runtime = undefined;
      if (this.manager?.runtime === runtime) this.manager = undefined;
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
