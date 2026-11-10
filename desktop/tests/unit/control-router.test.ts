import { afterEach, expect, test, vi } from "vitest";
import { ControlRouter } from "../../src/core/control-router";
import { InputController } from "../../src/core/input-controller";
import {
  defaultControls,
  type ControlBinding,
  type InputToken,
  type Modifier,
} from "../../src/shared/controls";
const key = (code: string): InputToken => ({ kind: "keyboard", code });
const pad = (index: number, device = "standard:x"): InputToken => ({
  kind: "gamepad",
  control: "button",
  index,
  device,
});
const bind = (
  id: string,
  target: string,
  input: InputToken | InputToken[],
  turbo: number | "default" | null = null,
  modifiers: Modifier[] = [],
): ControlBinding => ({
  id,
  target,
  inputs: Array.isArray(input) ? input : [input],
  modifiers,
  turbo,
});
function setup(
  bindings: ControlBinding[],
  flush?: () => Promise<void>,
  send?: (mask: number) => Promise<void>,
) {
  const values: number[] = [],
    actions: string[] = [],
    errors: unknown[] = [];
  const input = new InputController(async (mask) => {
    values.push(mask);
    await send?.(mask);
  });
  const router = new ControlRouter(
    { ...defaultControls(), bindings },
    {
      button: (bit, down, source) => input.button(bit, down, source),
      action: (id) => {
        actions.push(id);
      },
      release: () => input.releaseSources("control:"),
      ...(flush ? { flush } : {}),
      failed: (error) => errors.push(error),
    },
  );
  const event = (
    token: InputToken,
    down: boolean,
    modifiers: Modifier[] = [],
    source = "keyboard",
    epoch = router.epoch,
  ) => router.event({ input: token, down, modifiers, source, epoch });
  return { router, input, values, actions, errors, event };
}
afterEach(() => vi.useRealTimers());
test("remaps, repeats and multiple binding/device outputs preserve source OR", async () => {
  const s = setup([
    bind("x", "a", key("KeyJ")),
    bind("y", "b", key("KeyJ")),
    bind("pad", "a", pad(0)),
  ]);
  s.event(key("KeyX"), true);
  expect(s.input.buttons).toBe(0);
  s.event(key("KeyJ"), true);
  s.event(key("KeyJ"), true);
  s.event(pad(0), true, [], "pad:1");
  s.event(key("KeyJ"), false);
  expect(s.input.buttons).toBe(16);
  s.event(pad(0), false, [], "pad:1");
  await s.input.flush();
  expect(s.values).toEqual([16, 48, 16, 0]);
});
test("exact keyboard hotkeys fire on main key edge only and pad chords on all-held edge", () => {
  const s = setup([
    bind("shift", "audio.mute", key("KeyA"), null, ["Shift"]),
    bind("chord", "view.chassis", [pad(0), pad(1)]),
  ]);
  s.event(key("KeyA"), true);
  s.event(key("ShiftLeft"), true, ["Shift"]);
  s.event(key("KeyA"), true, ["Shift"]);
  expect(s.actions).toEqual([]);
  s.event(key("KeyA"), false, ["Shift"]);
  s.event(key("KeyA"), true, ["Shift"]);
  s.event(key("KeyA"), true, ["Shift"]);
  s.event(pad(0), true, [], "pad:1");
  s.event(pad(1), true, [], "pad:2");
  expect(s.actions).toEqual(["audio.mute"]);
  s.event(pad(1), true, [], "pad:1");
  s.event(pad(2), true, [], "pad:1");
  s.event(pad(1), false, [], "pad:1");
  s.event(pad(1), true, [], "pad:1");
  expect(s.actions).toEqual(["audio.mute", "view.chassis", "view.chassis"]);
});
test("isolation, epochs and reset quarantine held inputs independently until release", () => {
  const s = setup([bind("a", "a", key("KeyA")), bind("b", "b", key("KeyB"))]);
  s.event(key("KeyA"), true);
  const old = s.router.epoch;
  s.router.setBlocked(true);
  expect(s.input.buttons).toBe(0);
  s.event(key("KeyB"), true);
  s.event(key("KeyB"), false);
  s.router.setBlocked(false);
  s.event(key("KeyA"), true);
  expect(s.input.buttons).toBe(0);
  s.event(key("KeyB"), true);
  expect(s.input.buttons).toBe(32);
  s.event(key("KeyA"), false, [], "keyboard", old);
  s.event(key("KeyA"), true);
  expect(s.input.buttons).toBe(48);
  s.router.reset();
  s.event(key("KeyA"), false);
  s.event(key("KeyA"), true, [], "keyboard", old);
  expect(s.input.buttons).toBe(0);
  s.event(key("KeyA"), false);
  s.event(key("KeyA"), true);
  expect(s.input.buttons).toBe(16);
});
test("a stale press during isolation remains quarantined after close until physical release", () => {
  const s = setup([bind("a", "a", key("KeyA"))]);
  const old = s.router.epoch;
  s.router.setBlocked(true);
  s.event(key("KeyA"), true, [], "keyboard", old);
  s.router.setBlocked(false);
  s.event(key("KeyA"), true);
  expect(s.input.buttons).toBe(0);
  s.event(key("KeyA"), false);
  s.event(key("KeyA"), true);
  expect(s.input.buttons).toBe(16);
});
test("turbo has equal phases and cannot release a separate ordinary source", async () => {
  vi.useFakeTimers();
  const s = setup([
    bind("turbo", "a", key("KeyT"), 10),
    bind("plain", "a", key("KeyA")),
  ]);
  s.event(key("KeyT"), true);
  expect(s.input.buttons).toBe(16);
  vi.advanceTimersByTime(50);
  expect(s.input.buttons).toBe(0);
  vi.advanceTimersByTime(50);
  expect(s.input.buttons).toBe(16);
  s.event(key("KeyA"), true);
  vi.advanceTimersByTime(50);
  expect(s.input.buttons).toBe(16);
  s.event(key("KeyT"), false);
  s.event(key("KeyA"), false);
  vi.advanceTimersByTime(500);
  expect(s.input.buttons).toBe(0);
  await s.input.flush();
  expect(s.values).toEqual([16, 0, 16, 0]);
});
test("disconnect/config/dispose stop turbo and prevent held-source restart", () => {
  vi.useFakeTimers();
  const s = setup([bind("pad", "a", pad(0), "default")]);
  s.event(pad(0), true, [], "pad:1");
  s.router.releaseDevice("pad:1");
  vi.advanceTimersByTime(1000);
  expect(s.input.buttons).toBe(0);
  s.event(pad(0), true, [], "pad:2");
  s.router.setConfig({
    ...defaultControls(),
    bindings: [bind("other", "b", pad(0), 6)],
  });
  s.event(pad(0), true, [], "pad:2");
  expect(s.input.buttons).toBe(0);
  s.event(pad(0), false, [], "pad:2");
  s.event(pad(0), true, [], "pad:2");
  expect(s.input.buttons).toBe(32);
  s.router.dispose();
  vi.advanceTimersByTime(1000);
  s.event(pad(0), true, [], "pad:3");
  expect(s.input.buttons).toBe(0);
});
test("slow QMP bounds scheduler writes and release leaves timely neutral without stale callbacks", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let flushes = 0;
  const s = setup(
    [bind("turbo", "a", key("KeyT"), 10), bind("plain", "b", key("KeyB"))],
    () => {
      flushes++;
      return s.input.flush();
    },
    async () => {
      if (s.values.length === 1) await pending;
    },
  );
  s.event(key("KeyT"), true);
  await Promise.resolve();
  vi.advanceTimersByTime(5000);
  expect(flushes).toBe(1);
  expect(s.values).toEqual([16]);
  s.event(key("KeyB"), true);
  s.event(key("KeyB"), false);
  s.event(key("KeyT"), false);
  expect(s.input.buttons).toBe(0);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(500);
  await s.input.flush();
  expect(s.values).toEqual([16, 48, 16, 0]);
  expect(flushes).toBe(1);
});
test("isolation invalidates an unresolved scheduler flush and held turbo stays suppressed", async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const s = setup([bind("turbo", "a", key("KeyT"), 10)], () => pending);
  s.event(key("KeyT"), true);
  await Promise.resolve();
  s.router.setBlocked(true);
  s.router.setBlocked(false);
  s.event(key("KeyT"), true);
  fail(Error("old session disconnected"));
  await vi.advanceTimersByTimeAsync(500);
  expect(s.input.buttons).toBe(0);
  expect(s.errors).toEqual([]);
  s.router.dispose();
});
test("scheduler flush failure neutralizes turbo and reports once", async () => {
  vi.useFakeTimers();
  const s = setup([bind("turbo", "a", key("KeyT"), 10)], async () => {
    throw Error("QMP failed");
  });
  s.event(key("KeyT"), true);
  await vi.advanceTimersByTimeAsync(500);
  expect(s.input.buttons).toBe(0);
  expect(s.errors).toHaveLength(1);
});
test("an action entering isolation prevents later bindings from dispatching the same event", () => {
  const input = new InputController(async () => {});
  const actions: string[] = [];
  let router: ControlRouter;
  router = new ControlRouter(
    {
      ...defaultControls(),
      bindings: [
        bind("action", "file.open", key("KeyO")),
        bind("second", "file.make", key("KeyO")),
        bind("ordinary", "a", key("KeyO")),
      ],
    },
    {
      button: (bit, down, source) => input.button(bit, down, source),
      release: () => input.releaseAll(),
      action: (id) => {
        actions.push(id);
        router.setBlocked(true);
      },
    },
  );
  router.event({
    source: "keyboard",
    input: key("KeyO"),
    down: true,
    modifiers: [],
    epoch: router.epoch,
  });
  expect(input.buttons).toBe(0);
  expect(actions).toEqual(["file.open"]);
});
test("disabled raw gamepad inputs cannot be reactivated by an unrelated event", () => {
  const s = setup([bind("pad", "a", pad(0)), bind("key", "b", key("KeyB"))]);
  s.router.setConfig({
    ...defaultControls(),
    bindings: [bind("pad", "a", pad(0)), bind("key", "b", key("KeyB"))],
    devices: { "standard:x": { enabled: false, deadzone: 0.2 } },
  });
  s.event(pad(0), true, [], "mixed-source");
  s.event(key("KeyB"), true, [], "mixed-source");
  expect(s.input.buttons).toBe(32);
});
