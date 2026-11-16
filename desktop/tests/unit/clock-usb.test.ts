import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { SessionController } from "../../src/core/session-controller";

function live() {
  let usb = false;
  const commands: any[] = [];
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const controller = new SessionController({
    userData: "/tmp",
    qemu: "/qemu",
    logger,
    createDisplay: async () => undefined as any,
  });
  const read = async () => ({
    execution: "running" as const,
    devicePower: {
      battery: 100,
      usbPower: usb,
      batteryPresent: true,
      powered: true,
    },
  });
  const qmp = Object.assign(new EventEmitter(), {
    command: async (name: string, args: any) => {
      commands.push([name, args]);
      if (name === "qom-set" && args.property === "usb-power") usb = args.value;
    },
  });
  const runtime = {
    id: "session",
    qmp,
    backend: { readDeviceState: read },
    input: { releaseAll: vi.fn(), flush: async () => {} },
    powerWork: Promise.resolve(),
    deviceJobs: 0,
    execution: "running",
    stopping: false,
    uncertain: false,
  };
  (controller as any).runtime = runtime;
  controller.state = {
    status: "running",
    runtimeSessionId: runtime.id,
    ...awaitState(),
  };
  function awaitState() {
    return {
      execution: "running" as const,
      devicePower: {
        battery: 100,
        usbPower: false,
        batteryPresent: true,
        powered: true,
      },
    };
  }
  return {
    controller,
    commands,
    get usb() {
      return usb;
    },
  };
}
test("clock USB connects the running kernel and refuses manual disconnect until clock mode ends", async () => {
  const session = live();
  await (session.controller as any).setClockUsbRequired(true);
  expect(session.usb).toBe(true);
  expect(session.controller.state.devicePower?.usbPower).toBe(true);
  await session.controller.deviceAction("device.usb");
  expect(session.usb).toBe(true);
  await (session.controller as any).setClockUsbRequired(false);
  await session.controller.deviceAction("device.usb");
  expect(session.usb).toBe(false);
});
