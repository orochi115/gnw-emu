import { expect, test } from "vitest";
import {
  controlsSchema,
  defaultControls,
  findConflicts,
  deviceMatches,
  inputIdentity,
  type ControlBinding,
} from "../../src/shared/controls";

const key = (code: string) => ({ kind: "keyboard" as const, code });
const pad = (index: number, device = "standard") => ({
  kind: "gamepad" as const,
  device,
  control: "button" as const,
  index,
});
const binding = (
  id: string,
  target: string,
  inputs = [key("KeyA")],
  modifiers: any[] = [],
  turbo: any = null,
): ControlBinding => ({ id, target, inputs, modifiers, turbo });
test("defaults preserve all old keyboard inputs and add standard pad directions", () => {
  const config = controlsSchema.parse(defaultControls("darwin"));
  expect(
    config.bindings.find(
      (b) => b.inputs[0]?.kind === "keyboard" && b.inputs[0].code === "Tab",
    )?.target,
  ).toBe("select");
  expect(
    config.bindings.find(
      (b) => b.inputs[0]?.kind === "keyboard" && b.inputs[0].code === "KeyQ",
    )?.target,
  ).toBe("select");
  expect(
    config.bindings.find((b) => b.target === "file.open")?.modifiers,
  ).toEqual(["Meta"]);
  expect(config.bindings.filter((b) => b.target === "left")).toHaveLength(3);
});
test("strict bounded config rejects invalid outputs, axes, duplicate identities and hotkey turbo", () => {
  for (const bad of [
    binding("bad", "unknown"),
    binding("bad", "a", [key("a")]),
    binding("bad", "file.open", [key("KeyA")], [], 10),
    binding("bad", "a", [key("KeyA"), key("KeyB")]),
    { ...binding("bad", "a"), extra: true },
    { ...binding("bad", "a"), inputs: [{ ...pad(0), control: "axis" }] },
  ])
    expect(
      controlsSchema.safeParse({ ...defaultControls(), bindings: [bad] })
        .success,
    ).toBe(false);
  expect(
    controlsSchema.safeParse({
      ...defaultControls(),
      bindings: [binding("one", "a"), binding("two", "a")],
    }).success,
  ).toBe(false);
});
test("input identities use physical code and devices match reusable standard or exact fingerprint", () => {
  expect(inputIdentity(key("KeyA"))).not.toBe(inputIdentity(key("KeyB")));
  expect(deviceMatches("standard", "standard:controller:1")).toBe(true);
  expect(deviceMatches("standard", "other:controller:1")).toBe(false);
  expect(deviceMatches("pad-x", "pad-x")).toBe(true);
  expect(deviceMatches("pad-x", "pad-y")).toBe(false);
});
test("keyboard conflicts distinguish exact hotkeys but include hardware and turbo", () => {
  const config = {
    ...defaultControls(),
    bindings: [
      binding("plain", "a"),
      binding("turbo", "a", [key("KeyA")], [], 10),
      binding("shift", "audio.mute", [key("KeyA")], ["Shift"]),
      binding("ctrl", "view.chassis", [key("KeyA")], ["Control"]),
    ],
  };
  const conflicts = findConflicts(config);
  expect(conflicts.plain.map((c) => c.bindingId)).toEqual([
    "turbo",
    "shift",
    "ctrl",
  ]);
  expect(conflicts.shift.map((c) => c.bindingId)).toEqual(["plain", "turbo"]);
});
test("gamepad conflicts include contained chords and overlapping exact/standard devices", () => {
  const bindings: ControlBinding[] = [
    binding("single", "a", [pad(0)] as any),
    binding("short", "audio.mute", [pad(0)] as any),
    binding("long", "view.chassis", [
      pad(0, "standard:x"),
      pad(1, "standard:x"),
    ] as any),
    binding("other", "b", [pad(0, "vendor:x")] as any),
  ];
  const conflicts = findConflicts({ ...defaultControls(), bindings });
  expect(conflicts.single.map((c) => c.bindingId)).toEqual(["short", "long"]);
  expect(conflicts.other).toBeUndefined();
  expect(
    findConflicts({
      ...defaultControls(),
      bindings: [
        binding("x", "a", [key("KeyX")]),
        binding("z", "a", [key("KeyZ")]),
      ],
    }),
  ).toEqual({});
});
test("valid binding IDs cannot collide with conflict record prototypes", () => {
  const conflicts = findConflicts({
    ...defaultControls(),
    bindings: [binding("__proto__", "a"), binding("constructor", "b")],
  });
  expect(conflicts["__proto__"][0].bindingId).toBe("constructor");
});
test("partially overlapping gamepad chords warn on both bindings but unrelated devices do not", () => {
  const a = binding("a", "audio.mute", [
    pad(0, "standard:x"),
    pad(1, "standard:x"),
  ] as any);
  const b = binding("b", "view.chassis", [
    pad(1, "standard:x"),
    pad(2, "standard:x"),
  ] as any);
  const c = binding("c", "view.clock", [
    pad(1, "vendor:y"),
    pad(2, "vendor:y"),
  ] as any);
  const conflicts = findConflicts({
    ...defaultControls(),
    bindings: [a, b, c],
  });
  expect(conflicts.a.map((c) => c.bindingId)).toEqual(["b"]);
  expect(conflicts.b.map((c) => c.bindingId)).toEqual(["a"]);
  expect(conflicts.c).toBeUndefined();
});
