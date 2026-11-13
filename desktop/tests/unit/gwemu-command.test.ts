import { expect, test } from "vitest";
import { gwemuArguments } from "../../src/core/gwemu-command";
import type { Profile } from "../../src/core/schemas";
import type { Session } from "../../src/core/session-store";

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  model: "mario",
  internalFlash: "/source/bank1.bin",
  externalFlash: "/source/flash.bin",
  bank2Flash: "/source/bank2.bin",
  sdCard: "/source/sd.img",
  sdWiring: "spi1",
} as Profile;
const session = {
  directory: "/session",
  internalFlash: "/session/中文, bank1.bin",
  externalFlash: "/session/flash.bin",
  bank2Flash: "/session/bank2.bin",
  sdCard: "/session/sd.img",
  rtc: "2026-01-01T09:00:00",
  battery: 35,
  usbPower: true,
  batteryLifeMinutes: 480,
  chargeTimeMinutes: 180,
} as Session;
const endpoints = { qmpPort: 1234, gdbSocket: "/tmp/gdb.sock" };
const sizes = {
  internalFlash: 128 * 1024,
  externalFlash: 1024 * 1024,
  bank2Flash: 256 * 1024,
};

test("candidate binds only session copies, correct chip, RTC, SD and local endpoints", () => {
  const args = gwemuArguments(profile, session, endpoints, sizes);
  expect(args.join(" ")).not.toContain("/source/");
  expect(args).toContain("gnw-h7b0-soc.bank1-image=/session/中文, bank1.bin");
  expect(args).toContain("gnw-h7b0-soc.bank2-image=/session/bank2.bin");
  expect(args).toContain("gnw-h7b0-soc.extflash-image=/session/flash.bin");
  expect(args).toContain("gnw-h7b0-soc.extflash-chip=c2-25-34");
  expect(args).toContain("if=sd,format=raw,file=/session/sd.img");
  expect(args).toContain("base=2026-01-01T09:00:00,clock=vm");
  expect(args).toContain("gnw-h7b0-rtc.initial-epoch=1767258000");
  expect(args).toContain("tcp:127.0.0.1:1234,server=off");
  expect(args).toContain("unix:/tmp/gdb.sock,server=on,wait=off");
  expect(args).toContain("-S");
});

test.each([
  [4, "c2-25-36"],
  [64, "c2-25-3a"],
  [256, "c2-25-3c"],
])("maps %i MiB without changing image capacity", (mib, chip) => {
  expect(
    gwemuArguments(profile, session, endpoints, {
      ...sizes,
      externalFlash: Number(mib) * 1024 * 1024,
    }),
  ).toContain(`gnw-h7b0-soc.extflash-chip=${chip}`);
});

test("rejects unsupported capacity and oversized internal banks", () => {
  expect(() =>
    gwemuArguments(profile, session, endpoints, {
      ...sizes,
      externalFlash: 2 * 1024 * 1024,
    }),
  ).toThrow(/capacity/);
  expect(() =>
    gwemuArguments(profile, session, endpoints, {
      ...sizes,
      internalFlash: 1024 * 1024,
    }),
  ).toThrow(/256 KiB/);
});

test("maps requested raw UID bytes", () => {
  expect(
    gwemuArguments(
      { ...profile, deviceUid: "123456781234567812345678" },
      session,
      endpoints,
      sizes,
    ),
  ).toContain("gnw-h7b0-soc.uid=123456781234567812345678");
});

test("desktop endpoints bind the native frame and lock and leave GDB disabled", () => {
  const args = gwemuArguments(
    profile,
    session,
    { qmpPort: 1234, framePort: 4321 },
    sizes,
    { audio: false },
  );
  expect(args).toContain(
    `gnw-h7b0,sd-wiring=spi1,frame-endpoint=127.0.0.1:4321,session-lock=${process.platform === "win32" ? "\\session\\qemu.lock" : "/session/qemu.lock"},power-model=on,battery=35,battery-present=on,usb-power=on,battery-life-min=480,charge-time-min=180,instant-states=on,state-id=11111111-1111-4111-8111-111111111111`,
  );
  expect(args).not.toContain("-gdb");
  expect(args).toContain("gnw-h7b0-sai1.audio-muted=on");
  // A muted startup must keep the real audio backend initialized for live unmute.
  expect(args).not.toContain("none,id=snd0");
});

test("only desktop transport opts into snapshot identity and escapes machine values", () => {
  expect(gwemuArguments(profile, session, endpoints, sizes)[1]).not.toContain(
    "instant-states",
  );
  expect(
    gwemuArguments(
      { ...profile, id: "a,b" },
      session,
      { qmpPort: 1, framePort: 2 },
      sizes,
    )[1],
  ).toContain("instant-states=on,state-id=a,,b");
});

test.each(["spi1", "ospi", undefined] as const)(
  "maps SD wiring %s on both probe and desktop paths",
  (sdWiring) => {
    for (const framePort of [undefined, 4321]) {
      const args = gwemuArguments(
        { ...profile, sdWiring } as Profile,
        session,
        { ...endpoints, framePort },
        sizes,
      );
      expect(args[1]).toContain(`sd-wiring=${sdWiring ?? "spi1"}`);
      expect(args).toContain("if=sd,format=raw,file=/session/sd.img");
      expect(args.join(" ")).not.toContain("/source/");
    }
  },
);

test.each(["host", "2026-01-01T09:00:00"])(
  "RTC %s enables clock selection, guest setting and warm-reset retention",
  (rtc) => {
    const args = gwemuArguments(profile, { ...session, rtc }, endpoints, sizes);
    expect(args).toContain("gnw-h7b0-rtc.use-rtc-clock=on");
    expect(args).toContain("gnw-h7b0-rtc.preserve-calendar=on");
    expect(args).toContain("gnw-h7b0-rtc.sync-host=off");
    if (rtc === "host") {
      expect(args).toContain("base=localtime");
      expect(
        args.some((arg) => arg.startsWith("gnw-h7b0-rtc.initial-epoch=")),
      ).toBe(false);
    }
  },
);
