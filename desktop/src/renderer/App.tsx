import { t } from "../shared/locale";
import { useEffect, useState } from "react";
import type {
  AppState,
  InputState,
  ViewPreferences,
  WindowState,
} from "../shared/contracts";
import { WindowChrome } from "./components/WindowChrome";
import { GameScreen } from "./components/GameScreen";
import { MakeRomDialog } from "./components/MakeRomDialog";
const gameKeys = new Set([
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "KeyX",
  "KeyZ",
  "KeyG",
  "KeyT",
  "KeyP",
  "KeyO",
  "Enter",
  "Tab",
  "KeyQ",
  "Minus",
  "Equal",
  "KeyC",
]);
export function App() {
  const [state, setState] = useState<AppState>({ status: "idle" });
  const [host, setHost] = useState<WindowState>({
    clockMode: false,
    pixelPerfect: false,
    scaleFactor: 1,
    focused: true,
    maximized: false,
  });
  const [maker, setMaker] = useState(false);
  const [error, setError] = useState("");
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
      offMake();
      offPrefs();
      offInput();
      offHost();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        document.querySelector("dialog[open]") ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.repeat
      )
        return;
      if (state.status === "running" && gameKeys.has(e.code)) {
        e.preventDefault();
        window.desktop.key(e.code, e.type === "keydown");
      }
    };
    const release = () => window.desktop.releaseInput();
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", release);
    };
  }, [state.status]);
  const running =
    state.status === "running" ||
    state.status === "starting" ||
    state.status === "stopping";
  const desiredMask =
    input.runtimeSessionId === state.runtimeSessionId ? input.desiredMask : 0;
  const appliedMask =
    input.runtimeSessionId === state.runtimeSessionId ? input.appliedMask : 0;
  return (
    <main
      className={host.clockMode ? "desktop-clock" : "normal-window"}
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
          compact={host.clockMode}
          pixelPerfect={host.pixelPerfect}
          mask={desiredMask}
          disabled={state.status !== "running" || maker}
          resetGeneration={
            input.runtimeSessionId === state.runtimeSessionId
              ? input.resetGeneration
              : 0
          }
        />
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
            <span className="shortcut-hint">
              {t("app.loadHint")}{" "}
              <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} O</kbd>
            </span>
          </div>
        )}
        {state.status === "starting" && (
          <div className="loading-overlay" role="status">
            <span className="spinner" />
            <p>{t(`stage.${state.stage}`)}</p>
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
      {maker && <MakeRomDialog close={() => setMaker(false)} />}
    </main>
  );
}
