import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QmpClient } from "../src/core/qmp-client";
import { probeGdb } from "./gdb-probe";

async function limit<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeResult {
  status: "captured" | "failed";
  args?: string[];
  error?: string;
  stderr: string;
  observations: Record<string, unknown>;
  exitCode?: number | null;
  forcedTermination?: boolean;
}

export async function probeKernel(options: {
  binary: string;
  directory: string;
  seconds: number;
  makeArgs: (qmpPort: number, gdbSocket: string) => string[];
  gdb: boolean;
  input?: {
    command: string;
    press: Record<string, unknown>;
    release: Record<string, unknown>;
  };
}): Promise<ProbeResult> {
  const qmp = new QmpClient();
  const sockets = await mkdtemp(join(tmpdir(), "gnw-probe-"));
  const result: ProbeResult = {
    status: "failed",
    stderr: "",
    observations: {},
  };
  let child: ReturnType<typeof spawn> | undefined,
    exit: Promise<number | null> | undefined;
  let finished = false,
    observationTimer: NodeJS.Timeout | undefined;
  try {
    const port = await qmp.listen(),
      gdbSocket = join(sockets, "gdb.sock");
    result.args = options.makeArgs(port, gdbSocket);
    child = spawn(options.binary, result.args, {
      stdio: ["ignore", "ignore", "pipe"],
      // Ambient timelines/recorders must not redirect input or write outside this run.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(GNW_|GWEMU_)/.test(key),
        ),
      ),
    });
    child.stderr!.on("data", (data) => {
      result.stderr = (result.stderr + data.toString()).slice(-16384);
    });
    exit = new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code) => {
        result.exitCode = code;
        resolve(code);
      });
    });
    const unexpectedExit = exit.then((code) => {
      throw new Error(`Kernel exited before capture: ${code}`);
    });
    unexpectedExit.catch(() => {});
    const work = async () => {
      await limit(qmp.ready, 10000, "QMP startup");
      const observe = async (
        name: string,
        command: string,
        args?: Record<string, unknown>,
      ) => {
        try {
          result.observations[name] = await qmp.command(command, args);
        } catch (error) {
          result.observations[name] = { error: String(error) };
        }
      };
      await observe("machineProperties", "qom-list", { path: "/machine" });
      await observe("socProperties", "qom-list", { path: "/machine/soc" });
      await observe("commands", "query-commands");
      await observe("initialRegisters", "human-monitor-command", {
        "command-line": "info registers",
      });
      for (const [name, address, size] of [
        ["vectors", 0x08000000, 32],
        ["uid", 0x08fff800, 12],
        ["rtcRegisters", 0x58004000, 8],
      ] as const) {
        const path = join(options.directory, `${name}.bin`);
        await qmp.command("pmemsave", { val: address, size, filename: path });
        result.observations[name] = (await readFile(path)).toString("hex");
      }
      if (options.gdb)
        result.observations.gdbCapabilities = await probeGdb(gdbSocket);
      await qmp.command("cont");
      const wait = (seconds: number) =>
        new Promise<void>((resolve) => {
          observationTimer = setTimeout(resolve, seconds * 1000);
        });
      if (options.input) {
        await wait(0.5);
        if (finished) return;
        await qmp.command(options.input.command, options.input.press);
        await wait(0.3);
        if (finished) return;
        await qmp.command(options.input.command, options.input.release);
      }
      await wait(options.seconds - (options.input ? 0.8 : 0));
      if (finished) return;
      await qmp.command("stop");
      await observe("finalRegisters", "human-monitor-command", {
        "command-line": "info registers",
      });
      await observe("status", "query-status");
      await observe("vtor", "human-monitor-command", {
        "command-line": "x /1wx 0xe000ed08",
      });
      await qmp.command("screendump", {
        filename: join(options.directory, "screen.png"),
        format: "png",
      });
      result.status = "captured";
    };
    await Promise.race([work(), unexpectedExit]);
  } catch (error) {
    result.error = String(error);
  } finally {
    finished = true;
    clearTimeout(observationTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      await qmp.command("quit", undefined, 1000).catch(() => {});
      try {
        await limit(exit!, 3000, "Kernel shutdown");
      } catch {
        result.forcedTermination = true;
        child.kill("SIGKILL");
        await limit(exit!, 3000, "Kernel termination").catch((error) => {
          result.status = "failed";
          result.error = `${result.error ?? ""}; ${String(error)}`;
        });
      }
    }
    await qmp.close();
    await rm(sockets, { recursive: true, force: true });
  }
  return result;
}
