import { useEffect, useRef, useState } from "react";
import { t } from "../../../shared/locale";
import type {
  ControlBinding,
  ControlInputEvent,
  InputToken,
  Modifier,
} from "../../../shared/controls";
import { BindingSymbol, bindingDescription } from "./BindingIcons";
interface CaptureChoice extends ControlBinding {
  captureSource?: string;
}
export type InputSubscription = (
  listener: (event: ControlInputEvent) => void,
) => () => void;
export const turboOptions: (null | number)[] = [null, 6, 10, 15];
export function turboLabel(value: ControlBinding["turbo"], defaultHz: number) {
  return value === null
    ? t("controls.normal")
    : value === "default"
      ? t("controls.hz", { hz: defaultHz })
      : t("controls.hz", { hz: value });
}
export function TurboSegments({
  value,
  defaultHz,
  change,
}: {
  value: ControlBinding["turbo"];
  defaultHz: number;
  change: (value: ControlBinding["turbo"]) => void;
}) {
  return (
    <div
      className="controls-segments"
      role="radiogroup"
      aria-label={t("controls.turbo")}
    >
      {turboOptions.map((option) => (
        <button
          key={String(option)}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => change(option)}
        >
          {turboLabel(option, defaultHz)}
        </button>
      ))}
    </div>
  );
}
export function BindingDetails({
  target,
  binding,
  hotkey,
  defaultHz,
  conflictBindings,
  subscribeInput,
  selectCaptureSource,
  update,
  remove,
  close,
}: {
  target: string;
  binding?: ControlBinding;
  hotkey: boolean;
  defaultHz: number;
  conflictBindings: ControlBinding[];
  subscribeInput?: InputSubscription;
  selectCaptureSource?: (source: string) => void;
  update: (binding: ControlBinding) => boolean;
  remove: (id: string) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const capture = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState<ControlBinding>(
    binding ?? {
      id: crypto.randomUUID(),
      target,
      inputs: [],
      modifiers: [],
      turbo: null,
    },
  );
  const currentRef = useRef(current);
  currentRef.current = current;
  const [listening, setListening] = useState(false);
  const recordingStart = useRef(current);
  const [warning, setWarning] = useState("");
  const [choices, setChoices] = useState<CaptureChoice[]>([]);
  const candidateInputs = useRef<
    Map<string, { input: InputToken; source: string }>
  >(new Map());
  const held = useRef(new Set<string>());
  const gamepadPending = useRef<CaptureChoice[]>([]);
  const gamepadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apply = (choice: CaptureChoice) => {
    const { captureSource, ...next } = choice;
    if (captureSource) selectCaptureSource?.(captureSource);
    if (update(next)) {
      setCurrent(next);
      setListening(false);
      setChoices([]);
      setWarning("");
    } else setWarning(t("controls.duplicate"));
  };
  useEffect(() => {
    dialog.current!.showModal();
    capture.current?.focus();
    return () => {
      if (gamepadTimer.current) clearTimeout(gamepadTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!listening) return;
    candidateInputs.current.clear();
    held.current.clear();
    gamepadPending.current = [];
    const process = (event: ControlInputEvent) => {
      const input = event.input;
      if (input.kind !== "gamepad") return;
      if (hotkey && input.control !== "button") return;
      const identity = `${event.source}:${JSON.stringify(input)}`;
      const instanceSource = event.source.split(":").slice(0, 2).join(":");
      if (event.down) {
        if (held.current.has(identity)) return;
        held.current.add(identity);
        candidateInputs.current.set(identity, {
          input,
          source: instanceSource,
        });
        const inputs = hotkey
          ? [...candidateInputs.current.values()]
              .filter((item) => item.source === instanceSource)
              .map((item) => item.input)
          : [input];
        const next = {
          ...currentRef.current,
          inputs,
          modifiers: [],
          captureSource: instanceSource,
        };
        if (hotkey) {
          const { captureSource: _, ...preview } = next;
          setCurrent(preview);
          return;
        }
        gamepadPending.current.push(next);
        if (gamepadTimer.current === null)
          gamepadTimer.current = setTimeout(() => {
            gamepadTimer.current = null;
            const unique = gamepadPending.current.filter(
              (item, i, all) =>
                all.findIndex(
                  (other) =>
                    other.captureSource === item.captureSource &&
                    JSON.stringify(other.inputs) ===
                      JSON.stringify(item.inputs),
                ) === i,
            );
            gamepadPending.current = [];
            if (unique.length > 1) {
              setChoices(unique);
              setListening(false);
            } else if (unique[0]) apply(unique[0]);
          }, 60);
      } else {
        held.current.delete(identity);
        if (
          hotkey &&
          held.current.size === 0 &&
          candidateInputs.current.size > 0
        ) {
          const byDevice = new Map<string, InputToken[]>();
          for (const item of candidateInputs.current.values())
            byDevice.set(item.source, [
              ...(byDevice.get(item.source) ?? []),
              item.input,
            ]);
          const candidates = [...byDevice.entries()].map(
            ([source, inputs]) => ({
              ...currentRef.current,
              inputs,
              modifiers: [],
              captureSource: source,
            }),
          );
          if (candidates.length > 1) {
            setChoices(candidates);
            setListening(false);
          } else if (candidates[0]) apply(candidates[0]);
        }
      }
    };
    const off = subscribeInput?.(process);
    let keyboardCandidate: ControlBinding | null = null;
    const key = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const modifierKey = /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(
        event.code,
      );
      if (event.type === "keydown") {
        held.current.add(event.code);
        if (modifierKey && hotkey) return;
        const modifiers: Modifier[] = hotkey
          ? (["Control", "Shift", "Alt", "Meta"] as const).filter(
              (modifier) =>
                ({
                  Control: event.ctrlKey,
                  Shift: event.shiftKey,
                  Alt: event.altKey,
                  Meta: event.metaKey,
                })[modifier],
            )
          : [];
        const next = {
          ...currentRef.current,
          inputs: [{ kind: "keyboard" as const, code: event.code }],
          modifiers,
        };
        if (!hotkey) apply(next);
        else {
          keyboardCandidate = next;
          setCurrent(next);
        }
      } else {
        held.current.delete(event.code);
        if (
          keyboardCandidate &&
          held.current.size === 0 &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey
        )
          apply(keyboardCandidate);
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    return () => {
      off?.();
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      if (gamepadTimer.current) {
        clearTimeout(gamepadTimer.current);
        gamepadTimer.current = null;
      }
    };
  }, [listening, hotkey, subscribeInput]);
  const editValue = (next: ControlBinding) => {
    setCurrent(next);
    setListening(false);
    if (next.inputs.length > 0) {
      if (!update(next)) setWarning(t("controls.duplicate"));
      else setWarning("");
    }
  };
  return (
    <dialog
      ref={dialog}
      className="controls-detail"
      aria-labelledby="controls-detail-title"
      data-ui="controls.detail"
      onCancel={(event) => {
        event.preventDefault();
        if (!listening) close();
      }}
    >
      <h2 id="controls-detail-title">
        {t(binding ? "controls.details" : "controls.add")} ·{" "}
        {hotkey ? t(`controls.action.${target}`) : t(`button.${target}`)}
      </h2>
      <div className="controls-current-binding">
        {current.inputs.length > 0 ? (
          <>
            <BindingSymbol binding={current} />
            <div>
              {bindingDescription(current)}
              <small>
                →{" "}
                {hotkey
                  ? t(`controls.action.${target}`)
                  : t(`button.${target}`)}
              </small>
            </div>
          </>
        ) : (
          t("controls.unbound")
        )}
      </div>
      <button
        ref={capture}
        className={`controls-capture ${listening ? "listening" : ""}`}
        data-ui="controls.capture"
        aria-pressed={listening}
        onClick={() => {
          if (listening) return;
          recordingStart.current = current;
          setChoices([]);
          setWarning("");
          setListening(true);
          capture.current?.focus();
        }}
      >
        <span>
          {t(
            listening
              ? hotkey
                ? "controls.listenChord"
                : "controls.listen"
              : current.inputs.length > 0
                ? "controls.recordAgain"
                : "controls.record",
          )}
        </span>
      </button>
      {(listening || choices.length > 0) && (
        <button
          className="controls-stop-recording"
          data-ui="controls.capture.cancel"
          onClick={() => {
            setListening(false);
            setCurrent(recordingStart.current);
            setChoices([]);
            setWarning("");
          }}
        >
          {t("controls.cancelRecording")}
        </button>
      )}
      {choices.length > 0 && (
        <div className="controls-source-choices">
          <p>{t("controls.chooseSource")}</p>
          {choices.map((choice, index) => (
            <button key={index} onClick={() => apply(choice)}>
              {bindingDescription(choice)} ·{" "}
              {t("controls.interface", {
                instance: choice.captureSource?.split(":")[1],
              })}
            </button>
          ))}
        </div>
      )}
      {hotkey && current.inputs[0]?.kind === "keyboard" && !listening && (
        <div
          className="controls-modifiers"
          role="group"
          aria-label={t("controls.modifiers")}
        >
          {(["Control", "Shift", "Alt", "Meta"] as const).map((modifier) => (
            <button
              key={modifier}
              aria-pressed={current.modifiers.includes(modifier)}
              onClick={() =>
                editValue({
                  ...current,
                  modifiers: current.modifiers.includes(modifier)
                    ? current.modifiers.filter((value) => value !== modifier)
                    : [...current.modifiers, modifier],
                })
              }
            >
              {modifier === "Control"
                ? "Ctrl"
                : modifier === "Meta"
                  ? navigator.platform.includes("Mac")
                    ? "⌘"
                    : "Meta"
                  : modifier}
            </button>
          ))}
        </div>
      )}
      {!hotkey && !listening && (
        <div className="controls-detail-turbo">
          <h3>{t("controls.turbo")}</h3>
          <TurboSegments
            value={current.turbo}
            defaultHz={defaultHz}
            change={(turbo) => editValue({ ...current, turbo })}
          />
        </div>
      )}
      {warning && (
        <p role="alert" className="controls-warning">
          {warning}
        </p>
      )}
      {conflictBindings.length > 0 && (
        <div className="controls-conflicts" role="status">
          <h3>! {t("controls.conflict")}</h3>
          {conflictBindings.map((other) => (
            <p key={other.id}>
              {t(
                other.target.includes(".")
                  ? "controls.hotkeys"
                  : "controls.buttons",
              )}{" "}
              →{" "}
              {other.target.includes(".")
                ? t(`controls.action.${other.target}`)
                : t(`button.${other.target}`)}{" "}
              · {bindingDescription(other)}
            </p>
          ))}
          <small>{t("controls.conflictHint")}</small>
        </div>
      )}
      <footer className="controls-detail-actions">
        <button
          className="controls-danger"
          disabled={current.inputs.length === 0 || listening}
          data-ui="controls.detail.delete"
          onClick={() => {
            remove(current.id);
            close();
          }}
        >
          {t("controls.delete")}
        </button>
        <button
          className="controls-primary"
          disabled={listening}
          data-ui="controls.detail.done"
          onClick={close}
        >
          {t("controls.done")}
        </button>
      </footer>
    </dialog>
  );
}
