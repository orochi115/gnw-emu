import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuBarItem, WindowState } from "../../shared/contracts";
import { t } from "../../shared/locale";

export function WindowChrome({
  state,
  title,
}: {
  state: WindowState;
  title?: string;
}) {
  const [menus, setMenus] = useState<MenuBarItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const header = useRef<HTMLElement>(null);
  const bar = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.desktop.onMenuBar((items) => {
      if (live) setMenus(items);
    });
    void window.desktop.menuBar().then((items) => {
      if (live) setMenus(items);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      if (!header.current || !bar.current || !controls.current) return;
      setExpanded(
        menus.length > 0 &&
          header.current.clientWidth >=
            bar.current.scrollWidth + controls.current.offsetWidth + 48,
      );
    };
    const observer = new ResizeObserver(measure);
    for (const element of [header.current, bar.current, controls.current])
      if (element) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [menus, state.clockMode, state.controlWidth]);
  const open = (item: MenuBarItem, button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect();
    void window.desktop
      .openMenu(item.id, { x: bounds.left, y: bounds.bottom })
      .catch((error) =>
        window.desktop.log("error", "window.menu.failure", {
          message: error.message,
        }),
      );
  };
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
        ref={header}
        className="window-titlebar"
        style={{ maxWidth: state.controlWidth }}
        hidden={state.clockMode}
        onDoubleClick={() => {
          void window.desktop.windowAction("maximize");
        }}
      >
        {!expanded && control("menu", t("window.menu"), "☰")}
        <nav
          ref={bar}
          className={`window-menubar${expanded ? "" : " collapsed"}`}
          aria-label={t("window.menu")}
          aria-hidden={!expanded}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {menus.map((item) => (
            <button
              key={item.id}
              data-ui={item.id}
              disabled={!item.enabled}
              tabIndex={expanded ? 0 : -1}
              aria-haspopup="menu"
              onClick={(e) => open(item, e.currentTarget)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <span className="window-title">{title ?? "gnw-emu"}</span>
        <div
          ref={controls}
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
            void window.desktop.windowAction(action).catch((error) =>
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
