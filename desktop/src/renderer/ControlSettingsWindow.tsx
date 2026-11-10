import { useEffect, useRef, useState } from "react";
import { ControlsDialog } from "./components/controls/ControlsDialog";
import { useControlInput } from "./hooks/useControlInput";
import {
  defaultControls,
  type ControlsSettings,
  type Modifier,
} from "../shared/controls";
type Context = NonNullable<
  Awaited<ReturnType<Window["desktop"]["controlsWindow"]>>
>;
export function ControlSettingsWindow() {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(document.hasFocus());
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const [config, setConfig] = useState<ControlsSettings>(() =>
    defaultControls(),
  );
  const gamepads = useControlInput(
    config,
    epoch,
    focused,
    "capture:",
    context?.participation,
  );
  useEffect(() => {
    const offEpoch = window.desktop.onInputEpoch((value) => {
      epochRef.current = value;
      setEpoch(value);
    });
    const offConfig = window.desktop.onControlsChanged(setConfig);
    const focus = () => setFocused(true),
      blur = () => setFocused(false);
    const key = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const modifiers: Modifier[] = (
        ["Control", "Shift", "Alt", "Meta"] as const
      ).filter(
        (m) =>
          ({
            Control: event.ctrlKey,
            Shift: event.shiftKey,
            Alt: event.altKey,
            Meta: event.metaKey,
          })[m],
      );
      window.desktop.controlInput({
        source: "keyboard",
        input: { kind: "keyboard", code: event.code },
        down: event.type === "keydown",
        modifiers,
        epoch: epochRef.current,
      });
    };
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.desktop
      .controlsWindow()
      .then((value) => {
        if (!value) return;
        epochRef.current = value.epoch;
        setEpoch(value.epoch);
        setConfig(value.config);
        setContext(value);
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      offEpoch();
      offConfig();
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
    };
  }, []);
  if (!context) return error ? <p role="alert">{error}</p> : null;
  return (
    <ControlsDialog
      embedded
      page={context.page}
      initial={context.config}
      model={context.model}
      {...gamepads}
      save={(settings) =>
        window.desktop.saveControls(settings, gamepads.getParticipation())
      }
      close={() => window.desktop.closeControls()}
    />
  );
}
