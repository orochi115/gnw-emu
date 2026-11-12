import { expect, test } from "vitest";
import { KernelBackend, preflightKernel } from "../../src/core/kernel-backend";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Profile } from "../../src/core/schemas";

test("gwemu input sends ordered changed keys and releases a held combination", async () => {
  const calls: any[] = [];
  const qmp = {
    command: async (...args: any[]) => {
      calls.push(args);
    },
  };
  const backend = new KernelBackend("gwemu", qmp as any);
  await backend.buttons((1 << 0) | (1 << 7));
  await backend.buttons(1 << 8);
  await backend.buttons(0);
  expect(calls).toEqual([
    [
      "input-send-event",
      {
        events: [
          {
            type: "key",
            data: { down: true, key: { type: "qcode", data: "left" } },
          },
          {
            type: "key",
            data: { down: true, key: { type: "qcode", data: "g" } },
          },
        ],
      },
    ],
    [
      "input-send-event",
      {
        events: [
          {
            type: "key",
            data: { down: false, key: { type: "qcode", data: "left" } },
          },
          {
            type: "key",
            data: { down: false, key: { type: "qcode", data: "g" } },
          },
          {
            type: "key",
            data: { down: true, key: { type: "qcode", data: "esc" } },
          },
        ],
      },
    ],
    [
      "input-send-event",
      {
        events: [
          {
            type: "key",
            data: { down: false, key: { type: "qcode", data: "esc" } },
          },
        ],
      },
    ],
  ]);
});

test("failed input submission does not advance the backend mask", async () => {
  let reject = true;
  const calls: any[] = [];
  const backend = new KernelBackend("gwemu", {
    command: async (...args: any[]) => {
      calls.push(args);
      if (reject) throw new Error("disconnected");
    },
  } as any);
  await expect(backend.buttons(1)).rejects.toThrow("disconnected");
  reject = false;
  await backend.buttons(1);
  expect(calls[1]).toEqual(calls[0]);
});

test("power snapshot freezes guest time and rejects malformed readings", async () => {
  const calls: any[] = [];
  let battery: any = 42;
  const backend = new KernelBackend("gwemu", {
    command: async (...args: any[]) => {
      calls.push(args);
      if (args[0] === "qom-get")
        return args[1].property === "battery" ? battery : true;
    },
  } as any);
  expect(await backend.snapshotPower()).toEqual({
    battery: 42,
    usbPower: true,
  });
  expect(calls[0]).toEqual(["stop"]);
  battery = 101;
  await expect(backend.snapshotPower()).rejects.toThrow();
  battery = "42";
  await expect(backend.snapshotPower()).rejects.toThrow();
});

test("legacy input and mute keep their existing QOM contract", async () => {
  const calls: any[] = [];
  const backend = new KernelBackend("legacy", {
    command: async (...args: any[]) => {
      calls.push(args);
    },
  } as any);
  await backend.buttons(123);
  await backend.setMuted(true);
  expect(calls).toEqual([
    ["qom-set", { path: "/machine", property: "buttons", value: 123 }],
    ["qom-set", { path: "/machine", property: "audio-muted", value: true }],
  ]);
});

test("gwemu preflight rejects unsupported source capacity and OSPI before invoking a binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-preflight-"));
  try {
    await writeFile(join(root, "internal.bin"), Buffer.alloc(128 * 1024));
    await writeFile(join(root, "external.bin"), Buffer.alloc(2 * 1024 * 1024));
    const profile = {
      internalFlash: join(root, "internal.bin"),
      externalFlash: join(root, "external.bin"),
    } as Profile;
    await expect(
      preflightKernel("gwemu", profile, "/missing-binary"),
    ).rejects.toThrow(/capacity/);
    await expect(
      preflightKernel(
        "gwemu",
        { ...profile, sdCard: "/sd", sdWiring: "ospi" },
        "/missing-binary",
      ),
    ).rejects.toThrow(/OSPI/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
