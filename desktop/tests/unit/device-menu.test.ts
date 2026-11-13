import { expect, test } from "vitest";
import {
  menuTemplate,
  clockMenuTemplate,
  deviceMenuItems,
} from "../../src/main/menu";
import { defaultControls, HOTKEY_ACTIONS } from "../../src/shared/controls";

test("supply menu reflects running, paused, off and unknown execution", () => {
  for (const execution of [
    "running",
    "paused",
    "unpowered",
    "unknown",
  ] as const) {
    const items = deviceMenuItems({
      deviceSupported: true,
      canDevice: true,
      deviceState: {
        status: "running",
        execution,
        devicePower:
          execution === "unknown"
            ? undefined
            : {
                battery: 0,
                batteryPresent: false,
                usbPower: execution !== "unpowered",
                powered: execution !== "unpowered",
              },
      },
    });
    const item = (id: string) => items.find((value) => value.id === id)!;
    expect(item("device.batteryPresent").checked).toBe(false);
    expect(item("device.usb").checked).toBe(
      execution === "running" || execution === "paused",
    );
    expect(item("device.pause").enabled).toBe(execution === "running");
    expect(item("device.resume").enabled).toBe(execution === "paused");
    expect(item("device.coldStart").enabled).toBe(
      execution === "paused" || execution === "running",
    );
  }
});
test("device menu appears only for gwemu in normal menus", () => {
  const actions = {
    open() {},
    make() {},
    normal() {},
    dock() {},
    clockDock: "none" as const,
    canInteract: true,
    showChassis: true,
    toggleChassis() {},
    muted: false,
    toggleMute() {},
    quit() {},
  };
  expect(
    menuTemplate("darwin", actions).some((item) => item.id === "menu.device"),
  ).toBe(false);
  expect(
    clockMenuTemplate(actions).some((item) => item.id === "menu.device"),
  ).toBe(false);
  expect(
    menuTemplate("darwin", { ...actions, deviceSupported: true }).some(
      (item) => item.id === "menu.device",
    ),
  ).toBe(true);
});
test("new execution and presence hotkeys are available without adding default bindings", () => {
  const actions = [
    "device.batteryPresent",
    "device.pause",
    "device.resume",
    "device.coldStart",
  ];
  expect(
    actions.every((id) => HOTKEY_ACTIONS.some((action) => action.id === id)),
  ).toBe(true);
  expect(
    defaultControls().bindings.filter((binding) =>
      actions.includes(binding.target),
    ),
  ).toEqual([]);
});
