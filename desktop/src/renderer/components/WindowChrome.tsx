import type { WindowState } from "../../shared/contracts";
import { t } from "../../shared/locale";

export function WindowChrome({
  state,
  title,
}: {
  state: WindowState;
  title?: string;
}) {
  const control = (
    action: "menu" | "minimize" | "maximize" | "close" | "normal",
    label: string,
    symbol: string,
  ) => (
    <button
      data-ui={`window.${action}`}
      aria-label={label}
      title={label}
      onClick={() => {
        void window.desktop.windowAction(action).catch((error) =>
          window.desktop.log("error", "window.action.failure", {
            action,
            message: error.message,
          }),
        );
      }}
    >
      <span aria-hidden="true">{symbol}</span>
    </button>
  );
  return (
    <>
      <header
        className="window-titlebar"
        style={{ maxWidth: state.controlWidth }}
        hidden={state.clockMode}
        onDoubleClick={() => {
          void window.desktop.windowAction("maximize");
        }}
      >
        {control("menu", t("window.menu"), "☰")}
        <span className="window-title">{title ?? "gnw-emu"}</span>
        <div
          className="window-controls"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {control("minimize", t("menu.minimize"), "−")}
          {control(
            "maximize",
            t("window.maximize"),
            state.maximized ? "❐" : "□",
          )}
          {!state.clockMode && control("close", t("menu.close"), "×")}
        </div>
      </header>
    </>
  );
}

/** Place after the canvas so its no-drag region wins native hit testing on macOS. */
export function ClockControls({ state }: { state: WindowState }) {
  if (!state.clockMode) return null;
  return (
    <div
      className="clock-controls"
      aria-label={t("menu.clock")}
      style={{ right: `calc(100% - ${state.controlWidth}px + 6px)` }}
    >
      {(["normal", "close"] as const).map((action) => (
        <button
          key={action}
          data-ui={`window.${action}`}
          aria-label={t(action === "normal" ? "window.normal" : "menu.close")}
          title={t(action === "normal" ? "window.normal" : "menu.close")}
          onClick={() =>
            void window.desktop
              .windowAction(action)
              .catch((error) =>
                window.desktop.log("error", "window.action.failure", {
                  action,
                  message: error.message,
                }),
              )
          }
        >
          <span aria-hidden="true">{action === "normal" ? "↗" : "×"}</span>
        </button>
      ))}
    </div>
  );
}
