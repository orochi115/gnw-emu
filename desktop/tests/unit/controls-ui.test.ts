import { expect, test } from "vitest";
import { initializeLocale } from "../../src/shared/locale";
import { defaultControls } from "../../src/shared/controls";
import {
  keyboardLabel,
  normalizeControlsDraft,
} from "../../src/renderer/components/controls/presentation";

test("legacy default turbo becomes its saved frequency without changing saved settings", () => {
  const saved = defaultControls();
  saved.defaultTurboHz = 15;
  saved.bindings[0].turbo = "default";
  saved.bindings[1].turbo = 6;
  const draft = normalizeControlsDraft(saved);
  expect(draft.bindings[0].turbo).toBe(15);
  expect(draft.bindings[1].turbo).toBe(6);
  expect(saved.bindings[0].turbo).toBe("default");
  draft.bindings[0].inputs = [];
  expect(saved.bindings[0].inputs.length).toBeGreaterThan(0);
});

test("physical modifier labels keep their side and have compact readable icons", () => {
  initializeLocale("zh-CN");
  expect(keyboardLabel("MetaLeft", "MacIntel")).toEqual({
    short: "左⌘",
    long: "左 Command",
  });
  expect(keyboardLabel("MetaRight", "Win32")).toEqual({
    short: "右Win",
    long: "右 Windows",
  });
  expect(keyboardLabel("ShiftRight", "MacIntel")).toEqual({
    short: "右⇧",
    long: "右 Shift",
  });
  expect(keyboardLabel("ControlLeft", "Linux x86_64")).toEqual({
    short: "左Ctrl",
    long: "左 Ctrl",
  });
  expect(keyboardLabel("AltRight", "MacIntel")).toEqual({
    short: "右⌥",
    long: "右 Option",
  });
  initializeLocale("en");
  expect(keyboardLabel("MetaLeft", "MacIntel")).toEqual({
    short: "L⌘",
    long: "Left Command",
  });
});

test("ordinary keyboard labels preserve navigation keys for recording", () => {
  expect(keyboardLabel("Tab", "MacIntel").short).toBe("Tab");
  expect(keyboardLabel("Escape", "MacIntel").short).toBe("Esc");
  expect(keyboardLabel("KeyA", "MacIntel").short).toBe("A");
});
