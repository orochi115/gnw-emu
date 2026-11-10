import { z } from "zod";

export const LOGICAL_BUTTONS = [
  { id: "left", bit: 0 },
  { id: "up", bit: 1 },
  { id: "right", bit: 2 },
  { id: "down", bit: 3 },
  { id: "a", bit: 4 },
  { id: "b", bit: 5 },
  { id: "time", bit: 6 },
  { id: "game", bit: 7 },
  { id: "pause", bit: 8 },
  { id: "power", bit: 9 },
  { id: "start", bit: 10 },
  { id: "select", bit: 11 },
] as const;
export const HOTKEY_ACTIONS = [
  { id: "file.open" },
  { id: "file.make" },
  { id: "view.chassis" },
  { id: "view.clock" },
  { id: "audio.mute" },
  { id: "device.batteryDown" },
  { id: "device.batteryUp" },
  { id: "device.usb" },
] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]["id"];
export type Modifier = "Control" | "Shift" | "Alt" | "Meta";
export type InputToken =
  | { kind: "keyboard"; code: string }
  | {
      kind: "gamepad";
      device: string;
      control: "button" | "axis";
      index: number;
      direction?: -1 | 1;
    };
export interface ControlBinding {
  id: string;
  target: string;
  inputs: InputToken[];
  modifiers: Modifier[];
  turbo: number | "default" | null;
}
export interface ControlsSettings {
  version: 1;
  bindings: ControlBinding[];
  defaultTurboHz: number;
  devices: Record<string, { enabled: boolean; deadzone: number }>;
}
export interface ControlInputEvent {
  source: string;
  input: InputToken;
  down: boolean;
  modifiers: Modifier[];
  epoch: number;
}
export function isHotkeyTarget(target: string): target is HotkeyAction {
  return HOTKEY_ACTIONS.some((a) => a.id === target);
}
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !/[\0\r\n]/.test(s));
const modifiersSchema = z
  .array(z.enum(["Control", "Shift", "Alt", "Meta"]))
  .max(4)
  .refine((a) => new Set(a).size === a.length);
export const inputTokenSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("keyboard"),
      code: z
        .string()
        .regex(
          /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Up|Right|Down)|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Enter|Tab|Space|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu|(Shift|Control|Alt|Meta)(Left|Right))$/,
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gamepad"),
      device: identifier,
      control: z.enum(["button", "axis"]),
      index: z.number().int().min(0).max(63),
      direction: z.union([z.literal(-1), z.literal(1)]).optional(),
    })
    .strict()
    .refine((t) =>
      t.control === "axis"
        ? t.direction !== undefined && t.index < 16
        : t.direction === undefined,
    ),
]);
const turboSchema = z.union([
  z.literal(6),
  z.literal(10),
  z.literal(15),
  z.literal("default"),
  z.null(),
]);
const targets = [
  ...LOGICAL_BUTTONS.map((b) => b.id),
  ...HOTKEY_ACTIONS.map((a) => a.id),
] as [string, ...string[]];
export const controlBindingSchema = z
  .object({
    id: identifier,
    target: z.enum(targets),
    inputs: z.array(inputTokenSchema).min(1).max(8),
    modifiers: modifiersSchema,
    turbo: turboSchema,
  })
  .strict()
  .superRefine((binding, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      new Set(binding.inputs.map(inputIdentity)).size !== binding.inputs.length
    )
      fail("Duplicate input");
    if (!isHotkeyTarget(binding.target)) {
      if (binding.inputs.length !== 1 || binding.modifiers.length)
        fail("Ordinary bindings require one input and no modifiers");
    } else {
      if (binding.turbo !== null) fail("Hotkeys do not support turbo");
      const first = binding.inputs[0];
      if (first.kind === "keyboard") {
        if (binding.inputs.length !== 1)
          fail("Keyboard hotkeys require one main key");
      } else if (
        binding.modifiers.length ||
        binding.inputs.some(
          (t) =>
            t.kind !== "gamepad" ||
            t.control !== "button" ||
            t.device !== first.device,
        )
      )
        fail("Gamepad hotkeys require buttons from one device");
    }
  });
export function bindingIdentity(b: ControlBinding) {
  return JSON.stringify([
    b.target,
    b.inputs.map(inputIdentity).sort(),
    [...b.modifiers].sort(),
    b.turbo,
  ]);
}
export const controlsSchema: z.ZodType<ControlsSettings> = z
  .object({
    version: z.literal(1),
    bindings: z.array(controlBindingSchema).max(256),
    defaultTurboHz: z.union([z.literal(6), z.literal(10), z.literal(15)]),
    devices: z
      .record(
        identifier,
        z
          .object({
            enabled: z.boolean(),
            deadzone: z
              .number()
              .finite()
              .min(0.05)
              .max(0.6)
              .refine((n) => Math.abs(n * 20 - Math.round(n * 20)) < 1e-8),
          })
          .strict(),
      )
      .refine((v) => Object.keys(v).length <= 64),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      new Set(config.bindings.map((b) => b.id)).size !== config.bindings.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate binding ID" });
    if (
      new Set(config.bindings.map(bindingIdentity)).size !==
      config.bindings.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate binding" });
  });
export const controlInputSchema = z
  .object({
    source: identifier,
    input: inputTokenSchema,
    down: z.boolean(),
    modifiers: modifiersSchema,
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export function inputIdentity(input: InputToken) {
  return input.kind === "keyboard"
    ? `key:${input.code}`
    : JSON.stringify([
        input.device,
        input.control,
        input.index,
        input.direction ?? 0,
      ]);
}
export function deviceMatches(bindingDevice: string, device: string) {
  return bindingDevice === "standard"
    ? device.startsWith("standard:")
    : bindingDevice === device;
}
export function inputMatches(binding: InputToken, input: InputToken) {
  if (binding.kind !== input.kind) return false;
  if (binding.kind === "keyboard" && input.kind === "keyboard")
    return binding.code === input.code;
  return (
    binding.kind === "gamepad" &&
    input.kind === "gamepad" &&
    deviceMatches(binding.device, input.device) &&
    binding.control === input.control &&
    binding.index === input.index &&
    binding.direction === input.direction
  );
}
export function modifiersMatch(a: Modifier[], b: Modifier[]) {
  return a.length === b.length && a.every((m) => b.includes(m));
}
export function inputLabel(input: InputToken) {
  if (input.kind === "gamepad")
    return input.control === "button"
      ? `B${input.index}`
      : `Axis ${input.index}${input.direction === -1 ? "−" : "+"}`;
  return input.code
    .replace(/^Key|^Digit/, "")
    .replace(/^Arrow/, "")
    .replace(/^Numpad/, "Num ");
}
export function defaultControls(
  platform = typeof process === "undefined" ? "" : process.platform,
): ControlsSettings {
  const bindings: ControlBinding[] = [];
  const add = (target: string, input: InputToken, modifiers: Modifier[] = []) =>
    bindings.push({
      id: `default-${bindings.length}`,
      target,
      inputs: [input],
      modifiers,
      turbo: null,
    });
  const keyboard: Record<string, string> = {
    ArrowLeft: "left",
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    KeyX: "a",
    KeyZ: "b",
    KeyT: "time",
    KeyG: "game",
    KeyP: "pause",
    KeyO: "power",
    Enter: "start",
    Tab: "select",
    KeyQ: "select",
  };
  for (const [code, target] of Object.entries(keyboard))
    add(target, { kind: "keyboard", code });
  add("file.open", { kind: "keyboard", code: "KeyO" }, [
    platform === "darwin" ? "Meta" : "Control",
  ]);
  add("file.make", { kind: "keyboard", code: "KeyN" }, [
    platform === "darwin" ? "Meta" : "Control",
  ]);
  for (const [code, target] of [
    ["Minus", "device.batteryDown"],
    ["Equal", "device.batteryUp"],
    ["KeyC", "device.usb"],
  ])
    add(target, { kind: "keyboard", code });
  for (const [target, index] of [
    ["up", 12],
    ["down", 13],
    ["left", 14],
    ["right", 15],
    ["a", 0],
    ["b", 1],
    ["start", 9],
    ["select", 8],
  ] as const)
    add(target, {
      kind: "gamepad",
      device: "standard",
      control: "button",
      index,
    });
  for (const [target, index, direction] of [
    ["left", 0, -1],
    ["right", 0, 1],
    ["up", 1, -1],
    ["down", 1, 1],
  ] as const)
    add(target, {
      kind: "gamepad",
      device: "standard",
      control: "axis",
      index,
      direction,
    });
  return { version: 1, bindings, defaultTurboHz: 10, devices: {} };
}
export interface ControlConflict {
  bindingId: string;
  target: string;
  reason: "same-input" | "chord-overlap";
}
function inputOverlaps(a: InputToken, b: InputToken) {
  if (a.kind === "keyboard" || b.kind === "keyboard") return inputMatches(a, b);
  return (
    a.control === b.control &&
    a.index === b.index &&
    a.direction === b.direction &&
    (a.device === b.device ||
      deviceMatches(a.device, b.device) ||
      deviceMatches(b.device, a.device))
  );
}
export function findConflicts(
  config: ControlsSettings,
): Record<string, ControlConflict[]> {
  const result: Record<string, ControlConflict[]> = Object.create(null);
  for (let i = 0; i < config.bindings.length; i++)
    for (let j = i + 1; j < config.bindings.length; j++) {
      const a = config.bindings[i],
        b = config.bindings[j];
      if (a.target === b.target && a.turbo === b.turbo) continue;
      const hotA = isHotkeyTarget(a.target),
        hotB = isHotkeyTarget(b.target);
      if (
        a.inputs[0].kind === "keyboard" &&
        b.inputs[0].kind === "keyboard" &&
        hotA &&
        hotB &&
        !modifiersMatch(a.modifiers, b.modifiers)
      )
        continue;
      if (!a.inputs.some((t) => b.inputs.some((u) => inputOverlaps(t, u))))
        continue;
      const reason =
        a.inputs.length > 1 || b.inputs.length > 1
          ? "chord-overlap"
          : "same-input";
      (result[a.id] ??= []).push({ bindingId: b.id, target: b.target, reason });
      (result[b.id] ??= []).push({ bindingId: a.id, target: a.target, reason });
    }
  return result;
}
