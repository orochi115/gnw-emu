import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ControlInputEvent,
  ControlsSettings,
} from "../../shared/controls";
import type { InputSubscription } from "../components/controls/BindingDetails";
import { GamepadInputReader, type GamepadDevice } from "./gamepad-input";
/** Gamepad polling stays active during configuration; main owns routing isolation. */
export function useControlInput(
  config: ControlsSettings,
  epochValue: number,
  focused: boolean,
) {
  const [devices, setDevices] = useState<GamepadDevice[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const epoch = useRef(epochValue);
  epoch.current = epochValue;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const configRef = useRef(config);
  configRef.current = config;
  const reader = useRef(new GamepadInputReader());
  const listeners = useRef(new Set<(event: ControlInputEvent) => void>());
  const subscribeInput: InputSubscription = useCallback((listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const setDeviceParticipation = useCallback(
    (instance: string, enabled: boolean) =>
      reader.current.participate(instance, enabled),
    [],
  );
  useEffect(() => {
    const emit = (event: ControlInputEvent) => {
      window.desktop.controlInput(event);
      for (const listener of listeners.current) listener(event);
    };
    const release = () => {
      for (const value of reader.current.suspend(epoch.current)) emit(value);
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    let frame = 0;
    let lastDevices = "";
    let failed = false;
    const poll = () => {
      try {
        if (focusedRef.current && document.visibilityState === "visible") {
          if (typeof navigator.getGamepads !== "function")
            throw new Error("Gamepad API unsupported");
          const pads = Array.from(navigator.getGamepads());
          const sample = reader.current.sample(
            pads,
            configRef.current,
            epoch.current,
          );
          for (const event of sample.events) emit(event);
          const serialized = JSON.stringify(sample.devices);
          if (serialized !== lastDevices) {
            lastDevices = serialized;
            setDevices(sample.devices);
          }
          if (failed) {
            failed = false;
            setDeviceError("");
          }
        }
      } catch (cause) {
        if (!failed) {
          failed = true;
          setDeviceError(String(cause));
        }
        release();
      }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
      release();
    };
  }, []);
  useEffect(() => {
    if (!focused)
      for (const event of reader.current.suspend(epoch.current))
        window.desktop.controlInput(event);
  }, [focused]);
  return { devices, deviceError, subscribeInput, setDeviceParticipation };
}
