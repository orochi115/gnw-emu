import { test, expect } from "vitest";
import { ChassisPreference } from "../../src/core/chassis-preference";
import { InputController } from "../../src/core/input-controller";
test("hiding releases presses received while persistence is pending before publishing", async () => {
  let finish!: () => void;
  const disk = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const input = new InputController(async () => {});
  const snapshots: number[] = [];
  const view = new ChassisPreference(true, {
    persist: () => {
      started();
      return disk;
    },
    release: () => input.releaseSources("pointer:"),
    publish: () => snapshots.push(input.buttons),
  });
  const toggle = view.toggle();
  await pending;
  input.key("KeyX", true);
  input.button(5, true, "pointer:1");
  expect(input.buttons).toBe(48);
  finish();
  await toggle;
  expect(view.current).toEqual({ showChassis: false });
  expect(snapshots).toEqual([16]);
});
test("rapid toggles are serialized and persistence failure preserves the last preference", async () => {
  const saves: boolean[] = [];
  const view = new ChassisPreference(true, {
    persist: async (value) => {
      saves.push(value);
    },
    release: () => {},
    publish: () => {},
  });
  await Promise.all([view.toggle(), view.toggle(), view.toggle()]);
  expect(saves).toEqual([false, true, false]);
  expect(view.current).toEqual({ showChassis: false });
  let fail = true;
  const retry = new ChassisPreference(false, {
    persist: async () => {
      if (fail) throw Error("disk full");
    },
    release: () => {},
    publish: () => {},
  });
  await expect(retry.toggle()).rejects.toThrow("disk full");
  expect(retry.current).toEqual({ showChassis: false });
  fail = false;
  await retry.toggle();
  expect(retry.current).toEqual({ showChassis: true });
});
