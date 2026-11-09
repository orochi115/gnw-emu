import { expect, test } from "vitest";
import { qemuArguments } from "../../src/core/qemu-command";
test("QEMU options escape commas without shell interpolation", () => {
  const profile: any = {
    model: "zelda",
    internalFlash: "/tmp/中文, a.bin",
    externalFlash: "/tmp/b.bin",
  };
  const session: any = {
    directory: "/save",
    internalFlash: "/save/bank1.bin",
    externalFlash: "/save/flash.bin",
    battery: 100,
    usbPower: false,
    rtc: "host",
    batteryLifeMinutes: 480,
    chargeTimeMinutes: 180,
  };
  const args = qemuArguments(
    profile,
    session,
    { audio: false, realtime: true },
    { qmpPort: 1234, framePort: 4321, stateFile: "/run/state.json" },
  );
  expect(args).toContain("-S");
  expect(args[args.indexOf("-M") + 1]).toContain("internal=/tmp/中文,, a.bin");
  expect(args).toContain("tcp:127.0.0.1:1234,server=off");
  expect(args).toContain("none");
});
