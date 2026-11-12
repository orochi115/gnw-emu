import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadProfile } from "../src/core/profile-store";
import { prepareSession } from "../src/core/session-store";
import { qemuArguments } from "../src/core/qemu-command";
import { gwemuArguments } from "../src/core/gwemu-command";
import { writeJson } from "../src/core/atomic-file";
import { probeKernel, type ProbeResult } from "./kernel-probe";

const fields = [
  "internalFlash",
  "externalFlash",
  "bank2Flash",
  "sdCard",
] as const;
const execute = promisify(execFile);
const buttonKeys = [
  ["left", "left"],
  ["up", "up"],
  ["right", "right"],
  ["down", "down"],
  ["a", "x"],
  ["b", "z"],
  ["time", "t"],
  ["game", "g"],
  ["pause", "esc"],
  ["power", "p"],
  ["start", "ret"],
  ["select", "shift_r"],
];
export async function imageReceipt(path: string) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return { path, size: (await stat(path)).size, sha256: hash.digest("hex") };
}
type Receipt = Awaited<ReturnType<typeof imageReceipt>>;

export async function compareKernels(options: {
  profilePath: string;
  legacy: string;
  gwemu: string;
  outputDirectory: string;
  seconds: number;
  buttons?: string;
}) {
  if (
    !Number.isFinite(options.seconds) ||
    options.seconds <= 0 ||
    options.seconds > 60
  )
    throw new Error("seconds must be greater than zero and at most 60");
  const buttons = options.buttons ? options.buttons.split("+") : [];
  const indices = buttons.map((name) => {
    const index = buttonKeys.findIndex(([button]) => button === name);
    if (index < 0) throw new Error(`Unknown button: ${name}`);
    return index;
  });
  if (buttons.length && options.seconds <= 0.8)
    throw new Error("seconds must exceed 0.8 when pressing buttons");
  const profile = await loadProfile(resolve(options.profilePath));
  const sources: Partial<Record<(typeof fields)[number], Receipt>> = {};
  for (const key of fields)
    if (profile[key]) sources[key] = await imageReceipt(profile[key]!);
  const binaries = {
    legacy: resolve(options.legacy),
    gwemu: resolve(options.gwemu),
  };
  const artifacts = {} as Record<
    keyof typeof binaries,
    Receipt & { version: string }
  >;
  for (const key of ["legacy", "gwemu"] as const) {
    const receipt = await imageReceipt(binaries[key]);
    // A binary may reject --version; it can still provide a useful launch-failure report.
    const version = await execute(
      binaries[key],
      ["-display", "none", "--version"],
      {
        timeout: 3000,
        maxBuffer: 16384,
      },
    ).then(
      (result) => result.stdout.trim(),
      (error) => String(error),
    );
    artifacts[key] = { ...receipt, version };
  }
  const output = resolve(options.outputDirectory);
  // No recursive creation: an existing output (including symlinks) is always refused.
  await mkdir(output);
  const runs: (ProbeResult & {
    kernel: string;
    sessionDirectory: string;
    before: Record<string, Receipt>;
    after: Record<string, Receipt>;
  })[] = [];
  for (const kernel of ["legacy", "gwemu"] as const) {
    const before: Record<string, Receipt> = {},
      after: Record<string, Receipt> = {};
    let result: ProbeResult = {
      status: "failed",
      stderr: "",
      observations: {},
    };
    let phase = "session.prepare";
    const sessionDirectory = join(output, kernel, "sessions", profile.id);
    try {
      const session = await prepareSession(profile, join(output, kernel));
      session.rtc = "2026-01-01T09:00:00";
      phase = "session.hash.before";
      for (const key of fields)
        if (session[key]) {
          before[key] = await imageReceipt(session[key]!);
          if (before[key].sha256 !== sources[key]!.sha256)
            throw new Error(
              `Source changed during session preparation: ${key}`,
            );
        }
      phase = "kernel.probe";
      result = await probeKernel({
        binary: binaries[kernel],
        directory: session.directory,
        seconds: options.seconds,
        gdb: kernel === "gwemu",
        input: buttons.length
          ? kernel === "legacy"
            ? {
                command: "qom-set",
                press: {
                  path: "/machine",
                  property: "buttons",
                  value: indices.reduce((mask, bit) => mask | (1 << bit), 0),
                },
                release: { path: "/machine", property: "buttons", value: 0 },
              }
            : {
                command: "input-send-event",
                press: {
                  events: indices.map((index) => ({
                    type: "key",
                    data: {
                      down: true,
                      key: { type: "qcode", data: buttonKeys[index][1] },
                    },
                  })),
                },
                release: {
                  events: indices.map((index) => ({
                    type: "key",
                    data: {
                      down: false,
                      key: { type: "qcode", data: buttonKeys[index][1] },
                    },
                  })),
                },
              }
          : undefined,
        makeArgs: (qmpPort, gdbSocket) => {
          if (kernel === "gwemu")
            return gwemuArguments(
              profile,
              session,
              { qmpPort, gdbSocket },
              {
                internalFlash: before.internalFlash.size,
                externalFlash: before.externalFlash.size,
                bank2Flash: before.bank2Flash?.size,
              },
            );
          // Even legacy baseline inputs are copied: no kernel sees a source image path.
          const copies = {
            ...profile,
            internalFlash: session.internalFlash,
            externalFlash: session.externalFlash,
            bank2Flash: session.bank2Flash,
            sdCard: session.sdCard,
          };
          const args = qemuArguments(
            copies,
            session,
            { audio: false, realtime: false },
            {
              qmpPort,
              framePort: 1,
              stateFile: join(session.directory, "exit-state.json"),
            },
          );
          const machine = args.indexOf("-M") + 1;
          args[machine] = args[machine]
            .replace(/,frame-endpoint=[^,]+/, "")
            .replace(/,audio=on/, ",audio=off");
          return args;
        },
      });
      phase = "session.hash.after";
      for (const key of fields)
        if (session[key]) after[key] = await imageReceipt(session[key]!);
    } catch (error) {
      result = {
        ...result,
        status: "failed",
        error: `${phase}: ${String(error)}`,
      };
    }
    runs.push({
      ...result,
      kernel,
      sessionDirectory,
      before,
      after,
    });
    await writeJson(join(output, `${kernel}.json`), runs.at(-1));
  }
  const finalSources: typeof sources = {};
  const sourceErrors: Record<string, string> = {};
  for (const key of fields)
    if (profile[key]) {
      try {
        finalSources[key] = await imageReceipt(profile[key]!);
      } catch (error) {
        sourceErrors[key] = String(error);
      }
    }
  const sourceUnchanged = fields.every(
    (key) => sources[key]?.sha256 === finalSources[key]?.sha256,
  );
  const report = {
    formatVersion: 1,
    profile: profile.path,
    model: profile.model,
    observationSeconds: options.seconds,
    input: buttons.length
      ? { buttons, pressAtWallSeconds: 0.5, holdWallSeconds: 0.3 }
      : null,
    rtc: "2026-01-01T09:00:00",
    sources,
    finalSources,
    sourceErrors,
    sourceUnchanged,
    artifacts,
    runs,
    note: "Capture is a wall-clock startup observation, not desktop/toolchain acceptance.",
  };
  await writeJson(join(output, "report.json"), report);
  return report;
}
