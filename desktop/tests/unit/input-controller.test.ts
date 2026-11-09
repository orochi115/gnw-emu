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
