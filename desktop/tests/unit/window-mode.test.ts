import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ screen: {} }));
import { WindowMode } from "../../src/main/window-mode";

test("a dead runtime during fullscreen exit cannot finish entering clock mode", async () => {
  const host = Object.assign(new EventEmitter(), {
    isFocused: () => true,
    isMaximized: () => false,
    isFullScreen: () => true,
    isAlwaysOnTop: () => false,
    getNormalBounds: () => ({ x: 10, y: 20, width: 960, height: 600 }),
    setFullScreen: vi.fn(),
    unmaximize: vi.fn(),
    setMinimumSize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setContentSize: vi.fn(),
    setAspectRatio: vi.fn(),
    setBounds: vi.fn(),
  });
  let running = true;
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => running,
  );
  const entering = mode.toggle();
  expect(mode.transitioning).toBe(true);
  running = false;
  host.emit("leave-full-screen");
  await entering;
  expect(mode.state.clockMode).toBe(false);
  expect(host.setAlwaysOnTop).not.toHaveBeenCalledWith(true);
  expect(mode.transitioning).toBe(false);
});
