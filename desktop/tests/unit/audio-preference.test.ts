import { expect, test } from "vitest";
import { AudioPreference } from "../../src/core/audio-preference";

test("mute applies live without losing the committed preference on persistence failure", async () => {
  let runtime = true,
    saved = true,
    fail = true;
  const preference = new AudioPreference(true, {
    apply: async (enabled) => {
      runtime = enabled;
    },
    persist: async (enabled) => {
      if (fail) throw Error("disk unavailable");
      saved = enabled;
    },
  });
  await expect(preference.toggle()).rejects.toThrow("disk unavailable");
  expect([runtime, saved, preference.enabled]).toEqual([true, true, true]);
  fail = false;
  await Promise.all([
    preference.toggle(),
    preference.toggle(),
    preference.toggle(),
  ]);
  expect([runtime, saved, preference.enabled]).toEqual([false, false, false]);
});

test("runtime mute failure never commits settings", async () => {
  let writes = 0;
  const preference = new AudioPreference(true, {
    apply: async () => {
      throw Error("QMP disconnected");
    },
    persist: async () => {
      writes++;
    },
  });
  await expect(preference.toggle()).rejects.toThrow("QMP disconnected");
  expect(preference.enabled).toBe(true);
  expect(writes).toBe(0);
});
