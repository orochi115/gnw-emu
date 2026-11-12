import { existsSync } from "node:fs";
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

test("host release uses only the fixed native command and clears held input after confirmation", async () => {
  const calls: any[] = [];
  const backend = new KernelBackend("gwemu", {
    command: async (...args: any[]) => {
      calls.push(args);
      if (args[0] === "human-monitor-command")
        return "GNW host input released: 2\r\n";
    },
  } as any);
  await backend.buttons((1 << 0) | (1 << 9));
  backend.deferHostRelease();
  await backend.releaseHostInput();
  expect(backend.hasPendingRelease).toBe(false);
  await backend.buttons(1 << 0);
  expect(calls[1]).toEqual([
    "human-monitor-command",
    { "command-line": "gnw-release-host-input" },
  ]);
  expect(calls[2]).toEqual([
    "input-send-event",
    {
      events: [
        {
          type: "key",
          data: { down: true, key: { type: "qcode", data: "left" } },
        },
      ],
    },
  ]);
  expect(calls.some(([name]) => ["cont", "system_reset"].includes(name))).toBe(
    false,
  );
});

test.each([
  undefined,
  "GNW host input released: 13\r\n",
  "GNW host input released: -1\r\n",
  "GNW host input released: 0\r\nextra",
  "GNW host input released: 0\r\n\n",
  "unknown command",
  "x".repeat(1024),
])(
  "malformed host-release reply preserves pending cleanup (%s)",
  async (reply) => {
    const backend = new KernelBackend("gwemu", {
      command: async (name: string) =>
        name === "human-monitor-command" ? reply : undefined,
    } as any);
    await backend.buttons(1);
    backend.deferHostRelease();
    await expect(backend.releaseHostInput()).rejects.toThrow();
    expect(backend.hasPendingRelease).toBe(true);
  },
);

test("failed native host release keeps cleanup pending without continuing guest execution", async () => {
  const calls: any[] = [];
  const backend = new KernelBackend("gwemu", {
    command: async (...args: any[]) => {
      calls.push(args);
      if (args[0] === "human-monitor-command") throw new Error("disconnected");
    },
  } as any);
  await backend.buttons(1);
  backend.deferHostRelease();
  await expect(backend.releaseHostInput()).rejects.toThrow("disconnected");
  expect(backend.hasPendingRelease).toBe(true);
  expect(calls.map(([name]) => name)).toEqual([
    "input-send-event",
    "human-monitor-command",
  ]);
});

test("host release invalidates an older in-flight input completion", async () => {
  const calls: any[] = [];
  let submitted!: () => void;
  const backend = new KernelBackend("gwemu", {
    command: async (...args: any[]) => {
      calls.push(args);
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          submitted = resolve;
        });
      if (args[0] === "human-monitor-command")
        return "GNW host input released: 1\r\n";
    },
  } as any);
  const pending = backend.buttons(1);
  await backend.releaseHostInput();
  submitted();
  await pending;
  await backend.buttons(1);
  expect(calls[2]).toEqual(calls[0]);
});

test("legacy does not send the unsupported native host-release command", async () => {
  const calls: any[] = [];
  const backend = new KernelBackend("legacy", {
    command: async (...args: any[]) => {
      calls.push(args);
    },
  } as any);
  await expect(backend.releaseHostInput()).rejects.toThrow("requires gwemu");
  expect(calls).toEqual([]);
});

test("power snapshot freezes guest time and rejects malformed readings", async () => {
  const calls: any[] = [];
  let battery: any = 42;
  const backend = new KernelBackend("gwemu", {
    command: async (...args: any[]) => {
      calls.push(args);
      if (args[0] === "query-status") return { running: false };
      if (args[0] === "qom-get")
        return args[1].property === "battery" ? battery : true;
    },
  } as any);
  expect(await backend.snapshotPower()).toEqual({
    battery: 42,
    batteryPresent: true,
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

test("gwemu preflight rejects unsupported source capacity before invoking a binary", async () => {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(
  !existsSync(join(process.cwd(), "../build/gwemu-power/qemu-system-arm")),
)(
  "preflight refuses the old power-only binary with valid software SD configuration",
  async () => {
    const binary = join(process.cwd(), "../build/gwemu-power/qemu-system-arm");
    const root = await mkdtemp(join(tmpdir(), "gnw-preflight-old-"));
    try {
      await writeFile(join(root, "internal.bin"), Buffer.alloc(128 * 1024));
      await writeFile(join(root, "external.bin"), Buffer.alloc(1024 * 1024));
      await expect(
        preflightKernel(
          "gwemu",
          {
            internalFlash: join(root, "internal.bin"),
            externalFlash: join(root, "external.bin"),
            sdCard: "/sd",
            sdWiring: "ospi",
          } as Profile,
          binary,
        ),
      ).rejects.toThrow("error.kernelBuild");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
