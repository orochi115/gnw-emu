import { UserError, errorState } from "../shared/user-error";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { DisplayEndpoint } from "../display/receiver";
import type { AppState } from "../shared/contracts";
import { loadProfile } from "./profile-store";
import { prepareSession, saveSession, type Session } from "./session-store";
import { acquireLease } from "./session-lease";
import { loadSettings } from "./settings-store";
import { QmpClient } from "./qmp-client";
import { InputController } from "./input-controller";
import { qemuArguments } from "./qemu-command";
import { readJson } from "./atomic-file";
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
        const input = new InputController((mask) =>
          qmp!.command("qom-set", {
            path: "/machine",
            property: "buttons",
            value: mask,
          }),
        );
        const runtime: Runtime = {
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
        this.publish({ ...this.state, status: "running", stage: undefined });
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
    if (!runtime || this.state.status !== "running") return;
    if (down && ["Minus", "Equal", "KeyC"].includes(code)) {
      void this.deviceShortcut(code).catch((e) =>
        this.options.logger.error(
          { err: e, event: "shortcut" },
          "Device shortcut failed",
        ),
      );
      return;
    }
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
      ...this.runtime?.display.diagnostics(),
      buttons: this.runtime?.input.buttons ?? 0,
      qemuPid: this.runtime?.child?.pid,
      runtimeSessionId: this.runtime?.id,
    };
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.runtime) return Promise.resolve();
    this.stopPromise = this.stopRuntime().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
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
