import { test, expect } from "vitest";
import { validateAutomationParams } from "../../src/shared/automation-contracts";
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
