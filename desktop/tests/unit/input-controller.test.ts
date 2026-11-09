import { test, expect } from "vitest";
import { InputController } from "../../src/core/input-controller";
test("short taps serialize both edges, repeats ignored, blur releases", async () => {
  const values: number[] = [];
  const input = new InputController(async (mask) => {
    await new Promise((r) => setTimeout(r, 2));
    values.push(mask);
  });
  input.key("ArrowLeft", true);
  input.key("ArrowLeft", true);
  input.key("KeyX", true);
  input.key("ArrowLeft", false);
  input.releaseAll();
  await input.flush();
  expect(values).toEqual([1, 17, 16, 0]);
});
test("two physical sources of same device button survive releasing one", async () => {
  const values: number[] = [];
  const input = new InputController(async (mask) => {
    values.push(mask);
  });
  input.key("KeyX", true, "one");
  input.key("KeyX", true, "two");
  input.key("KeyX", false, "one");
  input.releaseAll();
  await input.flush();
  expect(values).toEqual([16, 0]);
});
test("pointer release preserves keyboard ownership and other pointers", async () => {
  const values: number[] = [];
  const input = new InputController(async (mask) => {
    values.push(mask);
  });
  input.key("KeyX", true);
  input.button(4, true, "pointer:1");
  input.button(5, true, "pointer:2");
  input.button(4, false, "pointer:1");
  expect(input.buttons).toBe(48);
  input.releaseSources("pointer:");
  expect(input.buttons).toBe(16);
  input.releaseAll();
  await input.flush();
  expect(values).toEqual([16, 48, 16, 0]);
});
test("desired feedback precedes QMP confirmation and applied states keep both tap edges", async () => {
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const snapshots: { desiredMask: number; appliedMask: number }[] = [];
  let sends = 0;
  const input = new InputController(
    async () => {
      if (++sends === 1) await first;
    },
    (s) => snapshots.push({ ...s }),
  );
  input.button(4, true, "pointer:1");
  input.button(4, false, "pointer:1");
  expect(input.snapshot).toEqual({
    desiredMask: 0,
    appliedMask: 0,
    resetGeneration: 0,
  });
  expect(snapshots).toEqual([
    { desiredMask: 16, appliedMask: 0, resetGeneration: 0 },
    { desiredMask: 0, appliedMask: 0, resetGeneration: 0 },
  ]);
  finish();
  await input.flush();
  expect(snapshots.slice(2)).toEqual([
    { desiredMask: 0, appliedMask: 16, resetGeneration: 0 },
    { desiredMask: 0, appliedMask: 0, resetGeneration: 0 },
  ]);
});
test("a failed QMP write never claims an applied button state", async () => {
  const input = new InputController(async () => {
    throw Error("disconnected");
  });
  input.button(5, true, "pointer:1");
  await expect(input.flush()).rejects.toThrow("disconnected");
  expect(input.snapshot).toEqual({
    desiredMask: 32,
    appliedMask: 0,
    resetGeneration: 0,
  });
});
test("explicit source reset is published even when keyboard keeps the aggregate mask unchanged", () => {
  const states: any[] = [];
  const input = new InputController(
    async () => {},
    (s) => states.push(s),
  );
  input.key("KeyX", true);
  input.button(4, true, "pointer:1");
  input.releaseSources("pointer:");
  expect(states.at(-1)).toMatchObject({ desiredMask: 16, resetGeneration: 1 });
  input.releaseAll();
  expect(states.at(-1)).toMatchObject({ desiredMask: 0, resetGeneration: 2 });
});
