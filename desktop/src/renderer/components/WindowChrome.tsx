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
        void window.desktop
          .windowAction(action)
          .catch((error) =>
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
      {state.clockMode && (
        <div className="clock-controls" aria-label={t("menu.clock")}>
          {control("normal", t("window.normal"), "↗")}
          {control("close", t("menu.close"), "×")}
        </div>
      )}
    </>
  );
}
