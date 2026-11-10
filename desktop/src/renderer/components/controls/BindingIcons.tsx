import { useState } from "react";
import { t } from "../../../shared/locale";
import type { ControlBinding, InputToken } from "../../../shared/controls";

export function shortInput(input: InputToken): string {
  if (input.kind === "gamepad")
    return input.control === "axis"
      ? `L${input.index + 1}${input.direction === -1 ? "−" : "+"}`
      : input.device === "standard" || input.device.startsWith("standard:")
        ? ([
            "A",
            "B",
            "X",
            "Y",
            "LB",
            "RB",
            "LT",
            "RT",
            "Back",
            "Start",
            "L3",
            "R3",
            "↑",
            "↓",
            "←",
            "→",
          ][input.index] ?? `B${input.index}`)
        : `B${input.index}`;
  return (
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
    )[input.code] ?? input.code.replace(/^Key|^Digit/, "")
  );
}
function gamepadName(device: string): string {
  if (device === "standard") return t("controls.standardGamepad");
  const parts = device.split(":");
  try {
    return decodeURIComponent(parts.slice(1, -1).join(":")) || device;
  } catch {
    return device;
  }
}
export function bindingDescription(binding: ControlBinding): string {
  return [
    ...binding.modifiers,
    ...binding.inputs.map((input) =>
      input.kind === "keyboard"
        ? `${t("controls.keyboard")} · ${shortInput(input)}`
        : `${gamepadName(input.device)} · ${shortInput(input)}`,
    ),
  ].join(" + ");
}
export function InputIcon({
  input,
  label,
}: {
  input?: InputToken;
  label?: string;
}) {
  return (
    <span
      className={`controls-input-icon ${input?.kind === "gamepad" ? "gamepad" : "keyboard"}`}
      aria-hidden="true"
    >
      {input?.kind === "gamepad" && (
        <svg viewBox="0 0 47 36">
          <path d="M11 5 Q4 5 3 15 L1 28 Q1 35 7 32 L14 26 H33 L40 32 Q46 35 46 28 L44 15 Q43 5 36 5 Z" />
        </svg>
      )}
      <span>{label ?? (input ? shortInput(input) : "?")}</span>
    </span>
  );
}
export function BindingSymbol({ binding }: { binding: ControlBinding }) {
  const parts = [
    ...binding.modifiers.map((modifier) => (
      <InputIcon
        key={modifier}
        label={
          modifier === "Control"
            ? "Ctrl"
            : modifier === "Meta"
              ? navigator.platform.includes("Mac")
                ? "⌘"
                : "Meta"
              : modifier
        }
      />
    )),
    ...binding.inputs.map((input, i) => <InputIcon key={i} input={input} />),
  ];
  return (
    <span
      className={`controls-binding-symbol ${parts.length > 1 ? "combination" : ""}`}
    >
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className="controls-combination-plus">+</span>}
          {part}
        </span>
      ))}
    </span>
  );
}
export function BindingRow({
  bindings,
  conflictIds,
  target,
  hotkey = false,
  edit,
  remove,
  menu,
}: {
  bindings: ControlBinding[];
  conflictIds: Set<string>;
  target: string;
  hotkey?: boolean;
  edit: (target: string, binding?: ControlBinding) => void;
  remove: (id: string) => void;
  menu: (binding: ControlBinding, position: { x: number; y: number }) => void;
}) {
  const [page, setPage] = useState(0);
  const limit = hotkey ? 2 : 2;
  const last = Math.max(0, Math.ceil(bindings.length / limit) - 1);
  const current = Math.min(page, last);
  return (
    <div className="controls-binding-row">
      <button
        className="controls-page-arrow"
        aria-label={t("controls.previous")}
        disabled={current === 0}
        onClick={() => setPage(current - 1)}
      >
        ‹
      </button>
      <div className={`controls-binding-page ${hotkey ? "hotkey" : ""}`}>
        {bindings.length === 0 && (
          <span className="controls-muted">{t("controls.unbound")}</span>
        )}
        {bindings
          .slice(current * limit, current * limit + limit)
          .map((binding) => (
            <span
              className={`controls-binding-wrap ${binding.turbo !== null ? "turbo" : ""} ${conflictIds.has(binding.id) ? "conflict" : ""}`}
              key={binding.id}
            >
              <button
                className="controls-binding"
                data-ui={`controls.binding.${binding.id}`}
                title={bindingDescription(binding)}
                aria-label={`${bindingDescription(binding)}${conflictIds.has(binding.id) ? ` · ${t("controls.conflict")}` : ""}${binding.turbo !== null ? ` · ${t("controls.turbo")}` : ""}`}
                onClick={() => edit(target, binding)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  menu(binding, { x: event.clientX, y: event.clientY });
                }}
              >
                <BindingSymbol binding={binding} />
                {binding.turbo !== null && (
                  <span className="controls-turbo-mark">⚡</span>
                )}
                {conflictIds.has(binding.id) && (
                  <span className="controls-conflict-mark">!</span>
                )}
              </button>
              <button
                className="controls-remove"
                aria-label={`${t("controls.delete")} ${bindingDescription(binding)}`}
                onClick={() => remove(binding.id)}
              >
                ×
              </button>
            </span>
          ))}
      </div>
      <button
        className="controls-page-arrow"
        aria-label={t("controls.next")}
        disabled={current === last}
        onClick={() => setPage(current + 1)}
      >
        ›
      </button>
      <button
        className="controls-plus"
        data-ui={`controls.add.${target}`}
        aria-label={`${t("controls.add")} ${t(`button.${target}`, { defaultValue: t(`controls.action.${target}`) })}`}
        onClick={() => {
          setPage(last);
          edit(target);
        }}
      >
        +
      </button>
    </div>
  );
}
