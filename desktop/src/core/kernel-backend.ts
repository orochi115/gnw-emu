import type { QmpClient } from "./qmp-client";
import { stat, open, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { StateIdentity } from "./savestate-store";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Profile } from "./schemas";
import {
  exitStateSchema,
  gwemuPowerSchema,
  gwemuPowerSnapshotSchema,
  type GwemuPowerSnapshot,
} from "./schemas";
import {
  requireSupplyCapabilities,
  requireSavestateCapabilities,
} from "./gwemu-capabilities";
import type { AppState } from "../shared/contracts";
import { saveSession, type Session } from "./session-store";
import { readJson } from "./atomic-file";
import { gwemuArguments, validateGwemuConfiguration } from "./gwemu-command";
import { qemuArguments } from "./qemu-command";
import { UserError } from "../shared/user-error";
export type KernelKind = "legacy" | "gwemu";
const keys = [
  "left",
  "up",
  "right",
  "down",
  "x",
  "z",
  "t",
  "g",
  "esc",
  "p",
  "ret",
  "shift_r",
];
function keyEvent(bit: number, down: boolean) {
  return {
    type: "key",
    data: { down, key: { type: "qcode", data: keys[bit] } },
  };
}

export function kernelEnvironment(kind: KernelKind) {
  return kind === "legacy"
    ? process.env
    : Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(GNW_|GWEMU_)/.test(key),
        ),
      );
}
async function imageSizes(images: {
  internalFlash: string;
  externalFlash: string;
  bank2Flash?: string;
}) {
  return {
    internalFlash: (await stat(images.internalFlash)).size,
    externalFlash: (await stat(images.externalFlash)).size,
    bank2Flash: images.bank2Flash
      ? (await stat(images.bank2Flash)).size
      : undefined,
  };
}
const execute = promisify(execFile);
export async function captureKernelIdentity(
  kind: KernelKind,
  binary: string,
): Promise<StateIdentity> {
  if (kind === "legacy") return { kernel: "legacy" };
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  return { kernel: "gwemu", buildSha256: hash.digest("hex") };
}
export async function verifyKernelIdentity(
  binary: string,
  identity: StateIdentity,
) {
  if (identity.kernel === "legacy") return;
  const actual = await captureKernelIdentity("gwemu", binary).catch(() => {
    throw new UserError("error.kernelBuild");
  });
  if (actual.kernel !== "gwemu" || actual.buildSha256 !== identity.buildSha256)
    throw new UserError("error.kernelBuild");
}
export async function preflightKernel(
  kind: KernelKind,
  profile: Profile,
  binary: string,
) {
  if (kind === "legacy") return { kernel: "legacy" } as const;
  validateGwemuConfiguration(profile, await imageSizes(profile));
  const identity = await captureKernelIdentity(kind, binary);
  const checks = await Promise.all(
    [
      ["-M", "gnw-h7b0,help"],
      ["-device", "gnw-h7b0-soc,help"],
      ["-device", "gnw-h7b0-sai1,help"],
    ].map((args) =>
      execute(binary, ["-display", "none", ...args], {
        env: kernelEnvironment(kind),
        timeout: 3000,
        maxBuffer: 65536,
      }),
    ),
  );
  const available = checks.map((value) => value.stdout + value.stderr);
  if (
    !available[0].includes("frame-endpoint") ||
    !available[0].includes("session-lock") ||
    ![
      "sd-wiring",
      "power-model",
      "battery",
      "battery-present",
      "usb-power",
      "battery-life-min",
      "charge-time-min",
    ].every((name) => available[0].includes(name)) ||
    !/\buid\b/.test(available[1]) ||
    !available[2].includes("audio-muted")
  )
    throw new UserError("error.kernelBuild");
  await requireSupplyCapabilities(binary, kernelEnvironment(kind));
  await requireSavestateCapabilities(binary, kernelEnvironment(kind));
  await verifyKernelIdentity(binary, identity);
  return identity;
}

export async function kernelArguments(
  kind: KernelKind,
  profile: Profile,
  session: Session,
  settings: { audio: boolean; realtime: boolean },
  endpoints: {
    qmpPort: number;
    framePort: number;
    stateFile: string;
    gdbSocket?: string;
  },
) {
  return kind === "legacy"
    ? qemuArguments(profile, session, settings, endpoints)
    : gwemuArguments(
        profile,
        session,
        endpoints,
        await imageSizes(session),
        settings,
      );
}

export async function finishKernelSession(
  kind: KernelKind,
  session: Session,
  stateFile: string,
  exitCode: number | null,
  power?: GwemuPowerSnapshot,
) {
  if (kind === "legacy") {
    const state = exitStateSchema.parse(await readJson(stateFile));
    await saveSession(session, state);
    return;
  }
  if (exitCode !== 0 || !power) throw new UserError("error.saveUncertain");
  // The gwemu images are shared file mappings. Flush after the child has exited,
  // including its RDP/unlock sidecars, before committing session metadata.
  for (const entry of await readdir(session.directory, {
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = await open(join(session.directory, entry.name), "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await saveSession(session, gwemuPowerSnapshotSchema.parse(power), "gwemu");
}

/** Kernel-specific control stays behind the UI's single QMP connection. */
export class KernelBackend {
  private mask = 0;
  private inputEpoch = 0;
  private releasePending = false;
  constructor(
    readonly kind: KernelKind,
    private qmp: QmpClient,
  ) {}
  async buttons(mask: number, timeout?: number) {
    if (this.kind === "legacy")
      return this.qmp.command("qom-set", {
        path: "/machine",
        property: "buttons",
        value: mask,
      });
    const epoch = this.inputEpoch;
    const events = [];
    if (this.releasePending) {
      for (let bit = 0; bit < keys.length; bit++)
        if (this.mask & (1 << bit)) events.push(keyEvent(bit, false));
      this.mask = 0;
      this.releasePending = false;
    }
    for (const down of [false, true])
      for (let bit = 0; bit < keys.length; bit++)
        if (
          Boolean(mask & (1 << bit)) === down &&
          Boolean(this.mask & (1 << bit)) !== down
        )
          events.push(keyEvent(bit, down));
    if (events.length) {
      if (timeout === undefined)
        await this.qmp.command("input-send-event", { events });
      else await this.qmp.command("input-send-event", { events }, timeout);
    }
    if (epoch === this.inputEpoch) this.mask = mask;
  }
  deferHostRelease() {
    this.releasePending = true;
  }
  get hasPendingRelease() {
    return this.releasePending;
  }
  resetHostInput() {
    this.inputEpoch++;
    this.mask = 0;
    this.releasePending = false;
  }
  async releaseHostInput(timeout?: number) {
    if (this.kind !== "gwemu")
      throw new Error("Host input release requires gwemu");
    const args = { "command-line": "gnw-release-host-input" };
    const reply =
      timeout === undefined
        ? await this.qmp.command("human-monitor-command", args)
        : await this.qmp.command("human-monitor-command", args, timeout);
    if (
      typeof reply !== "string" ||
      reply.length > 64 ||
      !/^GNW host input released: (?:[0-9]|1[0-2])\r?\n$/.test(reply)
    )
      throw new Error("Invalid host input release confirmation");
    this.resetHostInput();
  }
  async resetInput() {
    if (this.kind === "legacy") return this.buttons(0);
    await this.qmp.command("input-send-event", {
      events: keys.map((_key, bit) => keyEvent(bit, false)),
    });
    this.mask = 0;
    this.releasePending = false;
  }
  setMuted(muted: boolean) {
    return this.qmp.command("qom-set", {
      path: this.kind === "legacy" ? "/machine" : "/machine/soc/sai1",
      property: "audio-muted",
      value: muted,
    });
  }
  async snapshotPower() {
    await this.qmp.command("stop");
    const { devicePower } = await this.readDeviceState();
    const { battery, batteryPresent, usbPower } = devicePower;
    return { battery, batteryPresent, usbPower };
  }
  async readDeviceState(timeout = 5000): Promise<{
    execution: NonNullable<AppState["execution"]>;
    devicePower: NonNullable<AppState["devicePower"]>;
  }> {
    const battery = await this.qmp.command(
      "qom-get",
      {
        path: "/machine",
        property: "battery",
      },
      timeout,
    );
    const usbPower = await this.qmp.command(
      "qom-get",
      {
        path: "/machine",
        property: "usb-power",
      },
      timeout,
    );
    const batteryPresent = await this.qmp.command(
      "qom-get",
      {
        path: "/machine",
        property: "battery-present",
      },
      timeout,
    );
    const powered = await this.qmp.command(
      "qom-get",
      {
        path: "/machine",
        property: "powered",
      },
      timeout,
    );
    const devicePower = gwemuPowerSchema.parse({
      battery,
      usbPower,
      batteryPresent,
      powered,
    });
    if (powered !== (batteryPresent || usbPower))
      throw new Error("Inconsistent power sources");
    const status = await this.qmp.command("query-status", undefined, timeout);
    if (typeof status?.running !== "boolean" || (!powered && status.running))
      throw new Error("Invalid execution state");
    return {
      devicePower,
      execution: !powered ? "unpowered" : status.running ? "running" : "paused",
    };
  }
  async coldReset(timeout = 5000) {
    let timer: NodeJS.Timeout | undefined;
    let resolve!: () => void, reject!: (error: Error) => void;
    const reset = new Promise<void>((r, j) => {
      resolve = r;
      reject = j;
    });
    // A disconnect can precede the HMP reply. Handle rejection immediately.
    reset.catch(() => {});
    const event = (value: any) => {
      if (value.event === "RESET" && value.data?.reason === "host-ui")
        resolve();
    };
    const disconnect = () =>
      reject(new Error("QMP disconnected during cold reset"));
    this.qmp.on("event", event);
    this.qmp.on("disconnect", disconnect);
    timer = setTimeout(() => reject(new Error("Cold reset timeout")), timeout);
    try {
      const response = await this.qmp.command(
        "human-monitor-command",
        { "command-line": "gnw-cold-cycle" },
        timeout,
      );
      if (
        typeof response !== "string" ||
        !response.includes("GNW cold power cycle requested")
      )
        throw new Error(`Cold reset refused: ${response}`);
      await reset;
      // RESET is sent inside reset; this command runs after post-reset CPU sync.
      await this.qmp.command("query-status");
    } finally {
      clearTimeout(timer);
      this.qmp.off("event", event);
      this.qmp.off("disconnect", disconnect);
    }
  }
}
