import type { ControlsSettings } from "../../../shared/controls";
import { t } from "../../../shared/locale";

/** Resolve legacy turbo defaults in a detached editor draft. */
export function normalizeControlsDraft(
  settings: ControlsSettings,
): ControlsSettings {
  const draft = structuredClone(settings);
  for (const binding of draft.bindings)
    if (binding.turbo === "default") binding.turbo = draft.defaultTurboHz;
  return draft;
}

export function keyboardLabel(
  code: string,
  platform: string,
): { short: string; long: string } {
  const modifier = code.match(/^(Control|Shift|Alt|Meta)(Left|Right)$/);
  if (modifier) {
    const mac = platform.includes("Mac");
    const names: Record<string, [string, string]> = {
      Control: ["Ctrl", "Ctrl"],
      Shift: ["⇧", "Shift"],
      Alt: mac ? ["⌥", "Option"] : ["Alt", "Alt"],
      Meta: mac
        ? ["⌘", "Command"]
        : platform.includes("Win")
          ? ["Win", "Windows"]
          : ["Meta", "Meta"],
    };
    const [short, long] = names[modifier[1]];
    const side = modifier[2].toLowerCase();
    return {
      short: `${t(`controls.key.${side}Short`)}${short}`,
      long: `${t(`controls.key.${side}`)} ${long}`,
    };
  }
  const short =
    (
      {
        ArrowUp: "↑",
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
        Space: "Space",
        Enter: "↵",
        Escape: "Esc",
        Minus: "−",
        Equal: "+",
        Backspace: "⌫",
      } as Record<string, string>
    )[code] ?? code.replace(/^Key|^Digit/, "");
  return { short, long: short };
}
