import { t } from "../shared/locale";
import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  ToastMessage,
  InputState,
  ViewPreferences,
  WindowState,
} from "../shared/contracts";
import { WindowChrome, ClockControls } from "./components/WindowChrome";
import { GameScreen } from "./components/GameScreen";
import { MakeRomDialog } from "./components/MakeRomDialog";
import {
  inputLabel,
  defaultControls,
  type ControlsSettings,
  type Modifier,
} from "../shared/controls";
import { useControlInput } from "./hooks/useControlInput";
export function App() {
  const windows = navigator.platform.startsWith("Win");
  const dragging = useRef<number | undefined>(undefined);
  const [state, setState] = useState<AppState>({ status: "idle" });
  const [host, setHost] = useState<WindowState>({
    clockMode: false,
    clockDock: "none",
    pixelPerfect: false,
    scaleFactor: 1,
    pixelScale: 4,
    renderScale: null,
    normalScale: 4,
    clockScale: 1,
    preferredClockMode: false,
    transitioning: false,
    controlWidth: 960,
    focused: true,
    maximized: false,
  });
  const [maker, setMaker] = useState(false);
  const [controls, setControls] = useState<ControlsSettings>(() =>
    defaultControls(navigator.platform.includes("Mac") ? "darwin" : ""),
  );
  const [controlsOpen, setControlsOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const controlState = useRef({ controls, modal: false, running: false });
  controlState.current = {
    controls,
    modal: maker || controlsOpen,
    running:
      state.status === "running" &&
      (!state.execution || state.execution === "running") &&
      !state.deviceOperation,
  };

  const [error, setError] = useState("");
  useEffect(() => {
    const dragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      if (files.length !== 1) {
        setError(t("error.profileDropCount"));
        return;
      }
      setError("");
      window.desktop
        .openDroppedRom(files[0])
        .catch((error) => setError(error.message));
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.desktop.onToast((message) => {
      clearTimeout(timer);
      setToast((current) =>
        current?.kind === "error" && message.kind !== "error"
          ? current
          : message,
      );
      if (message.duration)
        timer = setTimeout(
          () => setToast((current) => (current === message ? null : current)),
          message.duration,
        );
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);
  const [preferences, setPreferences] = useState<ViewPreferences>({
    showChassis: true,
  });
  const [input, setInput] = useState<InputState>({
    desiredMask: 0,
    appliedMask: 0,
    resetGeneration: 0,
  });
  useEffect(() => {
    window.desktop.state().then(setState);
    let receivedEpoch = false,
      receivedControls = false;
    const offEpoch = window.desktop.onInputEpoch((value) => {
      receivedEpoch = true;
      epochRef.current = value;
      setEpoch(value);
    });
    const offControlsChanged = window.desktop.onControlsChanged((value) => {
      receivedControls = true;
      setControls(value);
    });
    const offControls = window.desktop.onControlsOpen((value) => {
      receivedControls = true;
      epochRef.current = value.epoch;
      setEpoch(value.epoch);
      setControls(value.config);
      setControlsOpen(true);
    });
    const offControlsClosed = window.desktop.onControlsClosed(() =>
      setControlsOpen(false),
    );
    window.desktop
      .controlsWindow()
      .then((value) => setControlsOpen(value !== null));
    window.desktop.controls().then((value) => {
      if (!receivedControls) setControls(value);
    });
    window.desktop.inputEpoch().then((value) => {
      if (!receivedEpoch) {
        epochRef.current = value;
        setEpoch(value);
      }
    });
    const off = window.desktop.onState(setState);
    const offMake = window.desktop.onMake(() => setMaker(true));
    let receivedHost = false;
    const offHost = window.desktop.onWindowState((value) => {
      receivedHost = true;
      setHost(value);
    });
    window.desktop.windowState().then((value) => {
      if (!receivedHost) setHost(value);
    });
    let receivedPrefs = false,
      receivedInput = false;
    const offPrefs = window.desktop.onPreferences((value) => {
      receivedPrefs = true;
      setPreferences(value);
    });
    const offInput = window.desktop.onInput((value) => {
      receivedInput = true;
      setInput(value);
    });
    window.desktop.preferences().then((value) => {
      if (!receivedPrefs) setPreferences(value);
    });
    window.desktop.inputState().then((value) => {
      if (!receivedInput) setInput(value);
    });
    return () => {
      off();
      offEpoch();
      offControls();
      offControlsClosed();
      offControlsChanged();
      offMake();
      offPrefs();
      offInput();
      offHost();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const modifiers: Modifier[] = (
        ["Control", "Shift", "Alt", "Meta"] as const
      ).filter(
        (m) =>
          ({
            Control: e.ctrlKey,
            Shift: e.shiftKey,
            Alt: e.altKey,
            Meta: e.metaKey,
          })[m],
      );
      window.desktop.controlInput({
        source: "keyboard",
        input: { kind: "keyboard", code: e.code },
        down: e.type === "keydown",
        modifiers,
        epoch: epochRef.current,
      });
      const current = controlState.current;
      if (current.modal || document.querySelector("dialog[open]")) return;
      const mapped = current.controls.bindings.some(
        (binding) =>
          binding.inputs.some(
            (input) => input.kind === "keyboard" && input.code === e.code,
          ) &&
          (binding.target.includes(".")
            ? binding.modifiers.length === modifiers.length &&
              binding.modifiers.every((m) => modifiers.includes(m))
            : current.running),
      );
      if (mapped) e.preventDefault();
    };
    const release = () => window.desktop.releaseInput();
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  useControlInput(controls, epoch, host.focused && !controlsOpen);
  const running =
    state.status === "running" ||
    state.status === "starting" ||
    state.status === "stopping";
  const desiredMask =
    input.runtimeSessionId === state.runtimeSessionId ? input.desiredMask : 0;
  const appliedMask =
    input.runtimeSessionId === state.runtimeSessionId ? input.appliedMask : 0;
  const openBinding = controls.bindings.find(
    (binding) =>
      binding.target === "file.open" && binding.inputs[0]?.kind === "keyboard",
  );
  return (
    <main
      className={
        host.clockMode
          ? `desktop-clock${windows ? " windows-clock" : ""}`
          : "normal-window"
      }
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          !windows ||
          !host.clockMode ||
          host.transitioning ||
          maker ||
          controlsOpen ||
          event.button !== 0 ||
          !target.closest(".game-screen") ||
          target.closest("button, [role=button], input, a")
        )
          return;
        event.preventDefault();
        dragging.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        window.desktop.clockDrag("start");
      }}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId)
          window.desktop.clockDrag("move");
      }}
      onPointerUp={(event) => {
        if (dragging.current !== event.pointerId) return;
        dragging.current = undefined;
        window.desktop.clockDrag("end");
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (dragging.current === undefined) return;
        dragging.current = undefined;
        window.desktop.clockDrag("end");
      }}
      data-ui="app"
      data-status={state.status}
      data-desired-mask={desiredMask}
      data-applied-mask={appliedMask}
    >
      <WindowChrome state={host} title={state.profileName} />
      <div className="window-content">
        <GameScreen
          runtimeSessionId={running ? state.runtimeSessionId : undefined}
          model={state.model}
          showChassis={preferences.showChassis}
          renderScale={host.renderScale}
          mask={desiredMask}
          disabled={
            state.status !== "running" ||
            (!!state.execution && state.execution !== "running") ||
            !!state.deviceOperation ||
            maker ||
            controlsOpen
          }
          resetGeneration={
            input.runtimeSessionId === state.runtimeSessionId
              ? input.resetGeneration
              : 0
          }
        />
        {state.status === "running" &&
          state.execution &&
          state.execution !== "running" && (
            <div
              data-ui="device-execution"
              role="status"
              className={`device-execution ${state.execution}`}
            >
              {t(`device.execution.${state.execution}`)}
            </div>
          )}
        {!running && (
          <div className="empty-state">
            <div className="empty-symbol" aria-hidden="true">
              <svg viewBox="0 0 48 48" fill="none">
                <rect x="6" y="8" width="36" height="27" rx="5" />
                <path d="M17 41h14M24 35v6M19 17l10 6-10 6z" />
              </svg>
            </div>
            <h1>{t(state.status === "error" ? "app.failed" : "app.empty")}</h1>
            <p>{state.status === "error" ? state.error : t("app.emptyHint")}</p>
            <div className="empty-actions">
              <button
                className="primary"
                data-ui="app.open"
                onClick={() =>
                  window.desktop.openRom().catch((e) => setError(e.message))
                }
              >
                {t("menu.open")}
              </button>
              <button
                className="text-button"
                data-ui="app.make"
                onClick={() => window.desktop.makeRom()}
              >
                {t("menu.make")}
              </button>
            </div>
            <button
              className="text-button"
              data-ui="app.controls"
              onClick={() =>
                window.desktop.openControls().catch((e) => setError(e.message))
              }
            >
              {t("menu.controls")}
            </button>
            {openBinding && (
              <span className="shortcut-hint">
                {t("app.loadHint")}{" "}
                <kbd>
                  {[
                    ...openBinding.modifiers.map((m) =>
                      m === "Meta"
                        ? navigator.platform.includes("Mac")
                          ? "⌘"
                          : "Meta"
                        : m === "Control"
                          ? "Ctrl"
                          : m,
                    ),
                    inputLabel(openBinding.inputs[0]),
                  ].join(" + ")}
                </kbd>
              </span>
            )}
          </div>
        )}
        {state.status === "starting" && (
          <div className="loading-overlay" role="status">
            <span className="spinner" />
            <p>{t(`stage.${state.stage}`)}</p>
          </div>
        )}
        {toast && !error && !state.error && (
          <div
            role={toast.kind === "error" ? "alert" : "status"}
            className={`toast toast-${toast.kind}`}
          >
            {toast.kind === "progress" && <span className="spinner" />}
            <span>{t(toast.code, toast.params)}</span>
            {toast.kind !== "progress" && (
              <button
                aria-label={t("app.dismiss")}
                onClick={() => setToast(null)}
              >
                ×
              </button>
            )}
          </div>
        )}
        {(error || (state.status === "running" && state.error)) && (
          <div role="alert" className="toast">
            <span>{error || state.error}</span>
            <button
              aria-label={t("app.dismiss")}
              onClick={() => {
                setError("");
                setState((v) => ({ ...v, error: undefined }));
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <ClockControls state={host} />
      {maker && <MakeRomDialog close={() => setMaker(false)} />}
    </main>
  );
}
