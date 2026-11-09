import { test, expect } from "vitest";
import { sessionSchema, settingsSchema } from "../../src/core/schemas";
test("persisted files require explicit version and calendar dates cannot roll over", () => {
  expect(() => sessionSchema.parse({ battery: 38 })).toThrow();
  expect(() => settingsSchema.parse({ audio: true })).toThrow();
  expect(() =>
    sessionSchema.parse({ formatVersion: 1, rtc: "2026-02-31T10:00:00" }),
  ).toThrow();
  expect(
    sessionSchema.parse({ formatVersion: 1, batteryLifeMinutes: 0 })
      .batteryLifeMinutes,
  ).toBe(0);
});
