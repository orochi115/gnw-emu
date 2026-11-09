import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
const display = vi.hoisted(() => ({ density: 2 }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    screen: Object.assign(new EventEmitter(), {
      getDisplayMatching: () => ({
        scaleFactor: display.density,
        workArea: { width: 1600, height: 1000 },
      }),
    }),
  };
});
import { screen } from "electron";
import { WindowMode } from "../../src/main/window-mode";

test("a dead runtime during fullscreen exit cannot finish entering clock mode", async () => {
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    isMaximized: () => false,
    isFullScreen: () => true,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ x: 10, y: 20, width: 960, height: 600 }),
    getContentSize: () => [960, 600],
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
  host.emit("closed");
});

test("display density changes retain exact pixels or a manually chosen size", async () => {
  display.density = 2;
  let width = 960,
    height = 600;
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    isMaximized: () => false,
    isFullScreen: () => false,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ x: 10, y: 20, width, height }),
    getNormalBounds: () => ({ x: 10, y: 20, width, height }),
    getContentSize: () => [width, height],
    setBounds: (bounds: any) => {
      width = bounds.width;
      height = bounds.height;
      host.emit("resize");
    },
    unmaximize: vi.fn(),
    setMinimumSize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setAspectRatio: vi.fn(),
    setContentSize: (w: number, h: number) => {
      width = w;
      height = h;
      host.emit("resize");
    },
  });
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  mode.fit("zelda", true);
  await mode.toggle();
  expect(host.getContentSize()).toEqual([366, 219]);
  expect(mode.state.pixelPerfect).toBe(true);
  display.density = 1;
  host.emit("move");
  expect(host.getContentSize()).toEqual([731, 437]);
  expect(mode.state.pixelPerfect).toBe(true);
  host.setContentSize(200, 120);
  expect(mode.state.pixelPerfect).toBe(false);
  display.density = 2;
  screen.emit("display-metrics-changed");
  expect(host.getContentSize()).toEqual([200, 120]);
  expect(mode.state.pixelPerfect).toBe(false);
  mode.restoreActualSize();
  expect(host.getContentSize()).toEqual([366, 219]);
  expect(mode.state.pixelPerfect).toBe(true);
  host.emit("closed");
});

test("restoring 1:1 at a mixed-density screen boundary does not oscillate", async () => {
  let x = -250,
    width = 365,
    height = 219,
    resizes = 0;
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    isMaximized: () => false,
    isFullScreen: () => false,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ x, y: 20, width, height }),
    getNormalBounds: () => ({ x, y: 20, width, height }),
    getContentSize: () => [width, height],
    setBounds: (b: any) => {
      x = b.x;
      width = b.width;
      height = b.height;
      host.emit("resize");
    },
    unmaximize: vi.fn(),
    setMinimumSize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setAspectRatio: vi.fn(),
    setContentSize: (w: number, h: number) => {
      if (++resizes > 10) throw Error("oscillating density");
      width = w;
      height = h;
      host.emit("resize");
    },
  });
  const match = vi.spyOn(screen, "getDisplayMatching").mockImplementation(
    (bounds) =>
      ({
        scaleFactor: bounds.x + bounds.width / 2 > 0 ? 2 : 1,
        workArea: { width: 1600, height: 1000 },
      }) as any,
  );
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  try {
    mode.fit("zelda", true);
    await expect(mode.toggle()).resolves.toBeUndefined();
    expect(mode.state).toMatchObject({ pixelPerfect: true, scaleFactor: 1 });
    expect(width).toBe(731);
    expect(x + width / 2).toBeCloseTo(-67.5, 0);
  } finally {
    host.emit("closed");
    match.mockRestore();
  }
});
