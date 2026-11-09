import { useEffect, useState } from "react";
import type { AppState } from "../shared/contracts";
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
  "Minus",
  "Equal",
  "KeyC",
]);
export function App() {
  const [state, setState] = useState<AppState>({ status: "idle" });
  const [maker, setMaker] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    window.desktop.state().then(setState);
    const off = window.desktop.onState(setState);
    const offMake = window.desktop.onMake(() => setMaker(true));
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
      off();
      offMake();
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", release);
    };
  }, [state.status]);
  const running =
    state.status === "running" ||
    state.status === "starting" ||
    state.status === "stopping";
  return (
    <main data-ui="app" data-status={state.status}>
      <GameScreen
        runtimeSessionId={running ? state.runtimeSessionId : undefined}
      />
      {!running && (
        <div className="empty-state">
          <div className="empty-symbol" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <rect x="6" y="8" width="36" height="27" rx="5" />
              <path d="M17 41h14M24 35v6M19 17l10 6-10 6z" />
            </svg>
          </div>
          <h1>{state.status === "error" ? "暂时无法运行" : "尚未加载 ROM"}</h1>
          <p>
            {state.status === "error"
              ? state.error
              : "从「文件」菜单加载 ROM，开始游戏。"}
          </p>
          <div className="empty-actions">
            <button
              className="primary"
              data-ui="app.open"
              onClick={() =>
                window.desktop.openRom().catch((e) => setError(e.message))
              }
            >
              加载 ROM…
            </button>
            <button
              className="text-button"
              data-ui="app.make"
              onClick={() => window.desktop.makeRom()}
            >
              制作 ROM…
            </button>
          </div>
          <span className="shortcut-hint">
            加载 ROM{" "}
            <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} O</kbd>
          </span>
        </div>
      )}
      {state.status === "starting" && (
        <div className="loading-overlay" role="status">
          <span className="spinner" />
          <p>{state.stage}</p>
        </div>
      )}
      {(error || (state.status === "running" && state.error)) && (
        <div role="alert" className="toast">
          <span>{error || state.error}</span>
          <button
            aria-label="关闭提示"
            onClick={() => {
              setError("");
              setState((v) => ({ ...v, error: undefined }));
            }}
          >
            ×
          </button>
        </div>
      )}
      {maker && <MakeRomDialog close={() => setMaker(false)} />}
    </main>
  );
}
