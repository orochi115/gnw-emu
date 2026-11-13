import { createRequire } from "node:module";
import { screen, type BrowserWindow } from "electron";

let api: ReturnType<typeof loadApi> | undefined;
function loadApi() {
  const koffi: typeof import("koffi") = createRequire(import.meta.url)("koffi");
  return {
    koffi,
    position: koffi
      .load("user32.dll")
      .func(
        "int __stdcall SetWindowPos(void *window, void *after, int x, int y, int width, int height, uint32 flags)",
      ),
  };
}

/** Electron's Windows frameless bounds conversion can grow a window on moves.
 * SWP_NOSIZE preserves its physical dimensions without a bounds round trip. */
export function moveWindowsWindow(window: BrowserWindow, x: number, y: number) {
  if (window.isDestroyed()) return;
  const native = (api ??= loadApi());
  const point = screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  const hwnd = native.koffi.decode(window.getNativeWindowHandle(), "void *");
  // NOSIZE | NOZORDER | NOACTIVATE; density changes remain WindowMode's job.
  if (!native.position(hwnd, null, point.x, point.y, 0, 0, 0x15))
    throw Error("SetWindowPos failed");
}
