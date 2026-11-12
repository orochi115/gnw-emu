import { test, expect } from "vitest";
import { validateAutomationParams } from "../../src/shared/automation-contracts";
test("supply menu actions are accepted in ordinary and clock menus with bounded IDs", () => {
  for (const method of ["ui.menu", "ui.contextMenu"])
    for (const id of [
      "device.batteryDown",
      "device.batteryUp",
      "device.batteryPresent",
      "device.usb",
      "device.pause",
      "device.resume",
      "device.coldStart",
    ])
      expect(validateAutomationParams(method, { id })).toEqual({ id });
  for (const method of ["ui.menu", "ui.contextMenu"])
    expect(() =>
      validateAutomationParams(method, { id: "device.unknown" }),
    ).toThrow();
});
test("clock context actions are bounded separately from File and native menu roles", () => {
  for (const id of [
    "clock.dock.topLeft",
    "clock.dock.none",
    "view.chassis",
    "audio.mute",
    "view.scale.half",
  ])
    expect(validateAutomationParams("ui.contextMenu", { id })).toEqual({ id });
  for (const id of ["file.open", "clock.dock.unknown", "edit.paste"])
    expect(() => validateAutomationParams("ui.contextMenu", { id })).toThrow();
});
test("automation rejects unbounded log queries and invalid typed UI parameters", () => {
  expect(() =>
    validateAutomationParams("logging.tail", { limit: 201 }),
  ).toThrow();
  expect(() =>
    validateAutomationParams("ui.fill", { id: "rom.internalFlash", value: 42 }),
  ).toThrow();
  expect(() =>
    validateAutomationParams("ui.waitFor", {
      condition: "ui.dialogOpen",
      value: true,
      timeoutMs: 60001,
    }),
  ).toThrow();
  expect(
    validateAutomationParams("ui.key", { key: "Left", down: false }),
  ).toEqual({ key: "Left", down: false });
});
test("pointer commands require a real target or bounded release coordinates", () => {
  expect(
    validateAutomationParams("ui.pointer", {
      id: "chassis.button.a",
      phase: "down",
    }),
  ).toEqual({ id: "chassis.button.a", phase: "down" });
  expect(
    validateAutomationParams("ui.pointer", { phase: "up", x: 2, y: 2 }),
  ).toEqual({ phase: "up", x: 2, y: 2 });
  for (const params of [
    { phase: "down" },
    { phase: "up", x: 2 },
    { phase: "down", x: 2, y: 2 },
    { phase: "up", x: -1, y: 2 },
    { phase: "move", id: "chassis.button.a" },
  ])
    expect(() => validateAutomationParams("ui.pointer", params)).toThrow();
  expect(validateAutomationParams("ui.menu", { id: "view.chassis" })).toEqual({
    id: "view.chassis",
  });
});
test("stable edit/window/quit menu actions are accepted without accepting arbitrary IDs", () => {
  for (const id of [
    "controls.open",
    "app.quit",
    "edit.copy",
    "window.close",
    "file.recent.0",
    "file.recent.9",
    "file.recent.clear",
    "view.scale.1",
  ])
    expect(validateAutomationParams("ui.menu", { id })).toEqual({ id });
  expect(() =>
    validateAutomationParams("ui.menu", { id: "unknown.menu" }),
  ).toThrow();
  for (const id of ["view.actualSize", "file.recent.10"])
    expect(() => validateAutomationParams("ui.menu", { id })).toThrow();
});

test("controls binding IDs and menu are available to UI automation", () => {
  expect(validateAutomationParams("ui.menu", { id: "controls.open" })).toEqual({
    id: "controls.open",
  });
  expect(
    validateAutomationParams("ui.click", { id: "controls.binding.default-4" }),
  ).toEqual({ id: "controls.binding.default-4" });
  expect(() =>
    validateAutomationParams("ui.click", { id: 'controls.binding.x"]' }),
  ).toThrow();
});
