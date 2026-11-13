import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSession, saveSession } from "../../src/core/session-store";
import { createProfile } from "../../src/core/profile-store";
import { KernelBackend } from "../../src/core/kernel-backend";

test("new gwemu session defaults and presence persistence require actual power snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-supply-schema-"));
  try {
    await writeFile(join(root, "internal.bin"), Buffer.alloc(128));
    await writeFile(join(root, "external.bin"), Buffer.alloc(1024));
    const profile = await createProfile(join(root, "test.gnw.json"), {
      model: "mario",
      internalFlash: join(root, "internal.bin"),
      externalFlash: join(root, "external.bin"),
    });
    const gwemu = await prepareSession(profile, join(root, "gwemu"));
    expect(gwemu.batteryPresent).toBe(true);
    await saveSession(
      gwemu,
      { battery: 0, usbPower: false, batteryPresent: false },
      "gwemu",
    );
    expect(
      (await prepareSession(profile, join(root, "gwemu"), "gwemu"))
        .batteryPresent,
    ).toBe(false);
    const saved = await readFile(join(gwemu.directory, "session.json"));
    await expect(
      saveSession(gwemu, { battery: 0, usbPower: false } as any, "gwemu"),
    ).rejects.toThrow();
    expect(await readFile(join(gwemu.directory, "session.json"))).toEqual(
      saved,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live native readback does not stop and strictly validates presence and powered", async () => {
  const calls: string[] = [];
  let present: any = false;
  const backend = new KernelBackend("gwemu", {
    command: async (name: string, args?: any) => {
      calls.push(name);
      if (name === "query-status") return { running: false, status: "paused" };
      return {
        battery: 0,
        "battery-present": present,
        "usb-power": false,
        powered: false,
      }[args.property as string];
    },
  } as any);
  expect(await backend.readDeviceState()).toEqual({
    execution: "unpowered",
    devicePower: {
      battery: 0,
      batteryPresent: false,
      usbPower: false,
      powered: false,
    },
  });
  expect(calls).not.toContain("stop");
  present = undefined;
  await expect(backend.readDeviceState()).rejects.toThrow();
  present = "false";
  await expect(backend.snapshotPower()).rejects.toThrow();
});

function coldFixture() {
  const qmp: any = new EventEmitter();
  const calls: string[] = [];
  qmp.command = async (name: string) => {
    calls.push(name);
    if (name === "human-monitor-command")
      return "GNW cold power cycle requested\n";
    return { running: false, status: "paused" };
  };
  return { qmp, calls, backend: new KernelBackend("gwemu", qmp) };
}
test("cold reset waits for matching RESET then main-loop barrier and cleans listeners", async () => {
  const { qmp, calls, backend } = coldFixture();
  let finished = false;
  const work = backend.coldReset(500).then(() => {
    finished = true;
  });
  await Promise.resolve();
  qmp.emit("event", { event: "RESET", data: { reason: "guest-reset" } });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(calls).toEqual(["human-monitor-command"]);
  qmp.emit("event", { event: "RESET", data: { reason: "host-ui" } });
  await work;
  expect(calls).toEqual(["human-monitor-command", "query-status"]);
  expect(qmp.listenerCount("event")).toBe(0);
  expect(qmp.listenerCount("disconnect")).toBe(0);
});
test("cold reset timeout and disconnect fail without continuing and clear listeners", async () => {
  for (const mode of ["timeout", "disconnect"] as const) {
    const { qmp, calls, backend } = coldFixture();
    const work = backend.coldReset(10);
    const rejection = expect(work).rejects.toThrow();
    if (mode === "disconnect") qmp.emit("disconnect");
    await rejection;
    expect(calls).not.toContain("cont");
    expect(qmp.listenerCount("event")).toBe(0);
    expect(qmp.listenerCount("disconnect")).toBe(0);
  }
});
test("cold HMP refusal and command errors release pending RESET listeners", async () => {
  for (const mode of ["refused", "error"]) {
    const { qmp, backend } = coldFixture();
    qmp.command = async () => {
      if (mode === "error") throw new Error("HMP unavailable");
      return "GNW cold cycle refused: no power supply\n";
    };
    await expect(backend.coldReset(1000)).rejects.toThrow();
    expect(qmp.listenerCount("event")).toBe(0);
    expect(qmp.listenerCount("disconnect")).toBe(0);
  }
});
