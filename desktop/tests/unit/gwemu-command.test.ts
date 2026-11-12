import { expect, test } from "vitest";
import { gwemuArguments } from "../../src/core/gwemu-command";
import type { Profile } from "../../src/core/schemas";
import type { Session } from "../../src/core/session-store";

const profile = {
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

test("maps requested raw UID bytes and refuses OSPI wiring", () => {
  expect(
    gwemuArguments(
      { ...profile, deviceUid: "123456781234567812345678" },
      session,
      endpoints,
      sizes,
    ),
  ).toContain("gnw-h7b0-soc.uid=123456781234567812345678");
  expect(() =>
    gwemuArguments({ ...profile, sdWiring: "ospi" }, session, endpoints, sizes),
  ).toThrow(/OSPI/);
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
    "gnw-h7b0,frame-endpoint=127.0.0.1:4321,session-lock=/session/qemu.lock,power-model=on,battery=35,usb-power=on,battery-life-min=480,charge-time-min=180",
  );
  expect(args).not.toContain("-gdb");
  expect(args).toContain("gnw-h7b0-sai1.audio-muted=on");
  // A muted startup must keep the real audio backend initialized for live unmute.
  expect(args).not.toContain("none,id=snd0");
});
