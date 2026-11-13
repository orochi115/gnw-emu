import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
const display = vi.hoisted(() => ({
  density: 2,
  workArea: { x: 0, y: 0, width: 1600, height: 1000 },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    screen: Object.assign(new EventEmitter(), {
      getDisplayMatching: () => ({
        scaleFactor: display.density,
        workArea: display.workArea,
      }),
    }),
  };
});
import { screen } from "electron";
import { WindowMode } from "../../src/main/window-mode";

beforeEach(() => {
  display.density = 2;
  display.workArea = { x: 0, y: 0, width: 1600, height: 1000 };
});

test.each([undefined, 64])(
  "startup fits default or saved scale %s inside a Windows work area at density 1.5",
  async (normalScale) => {
    display.density = 1.5;
    display.workArea = { x: 0, y: 0, width: 1707, height: 1018 };
    const host = resizingHost({ x: 1200, y: 800, width: 960, height: 640 });
    const patches: any[] = [];
    const mode = new WindowMode(
      host as any,
      () => {},
      () => {},
      () => true,
      { normalScale },
      (patch) => patches.push(patch),
    );
    try {
      // Match main-process startup: empty view, then starting/running profile.
      mode.setGameAvailable(false);
      await mode.fit(undefined, true);
      mode.setGameAvailable(true);
      await mode.fit("zelda", true);
      const bounds = host.getBounds();
      expect(mode.state.pixelScale).toBe(3);
      expect(mode.state.normalScale).toBe(3);
      expect(patches).toContainEqual({ normalScale: 3 });
      expect(bounds.width).toBeLessThanOrEqual(display.workArea.width);
      expect(bounds.height).toBeLessThanOrEqual(display.workArea.height);
      expect(bounds.x).toBeGreaterThanOrEqual(display.workArea.x);
      expect(bounds.y).toBeGreaterThanOrEqual(display.workArea.y);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1707);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(1018);
      expect(mode.canSetScale(3)).toBe(true);
      expect(mode.canSetScale(4)).toBe(false);
    } finally {
      host.emit("closed");
    }
  },
);

test("startup fitting includes the titlebar on a height-limited display", async () => {
  display.density = 1;
  display.workArea = { x: -1920, y: 50, width: 1920, height: 500 };
  const host = resizingHost({ x: -1000, y: 450, width: 960, height: 640 });
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  try {
    await mode.fit("zelda", true);
    expect(mode.state.pixelScale).toBe(1);
    const bounds = host.getBounds();
    expect(bounds.height).toBeLessThanOrEqual(500);
    expect(bounds.y).toBeGreaterThanOrEqual(50);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(550);
  } finally {
    host.emit("closed");
  }
});

test("startup preserves a saved fractional scale that already fits", async () => {
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
    { normalScale: 1.25 },
  );
  try {
    await mode.fit("zelda", true);
    expect(mode.state.pixelScale).toBe(1.25);
    expect(mode.state.normalScale).toBe(1.25);
  } finally {
    host.emit("closed");
  }
});

test("clock docking survives scale/frame changes, persists and releases on manual drag", async () => {
  display.density = 2;
  const host = resizingHost();
  const patches: any[] = [];
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
    {},
    (patch) => patches.push(patch),
  );
  await mode.fit("zelda", false);
  await mode.toggle();
  mode.setDock("bottomRight");
  expect(host.getBounds()).toEqual({
    x: 1428,
    y: 868,
    width: 160,
    height: 120,
  });
  await mode.setScale(2);
  expect(host.getBounds()).toEqual({
    x: 1268,
    y: 748,
    width: 320,
    height: 240,
  });
  await mode.fit("zelda", true);
  const bounds = host.getBounds();
  expect(bounds.x + bounds.width).toBe(1588);
  expect(bounds.y + bounds.height).toBe(988);
  expect(mode.state.pixelScale).toBe(2);
  expect(mode.state.clockDock).toBe("bottomRight");
  host.setBounds({ x: 400, y: 300 });
  expect(mode.state.clockDock).toBe("none");
  expect(patches).toContainEqual({ clockDock: "none" });
  host.emit("closed");
});

function resizingHost(initial = { x: 100, y: 100, width: 960, height: 640 }) {
  let bounds = { ...initial };
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    isMaximized: (): boolean => false,
    isFullScreen: () => false,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ ...bounds }),
    getNormalBounds: () => ({ ...bounds }),
    getContentSize: () => [bounds.width, bounds.height],
    setBounds: (next: any) => {
      const old = bounds;
      bounds = { ...bounds, ...next };
      if (bounds.width !== old.width || bounds.height !== old.height)
        host.emit("resize");
      if (bounds.x !== old.x || bounds.y !== old.y) host.emit("move");
    },
    setContentSize: (width: number, height: number) => {
      bounds = { ...bounds, width, height };
      host.emit("resize");
    },
    setMinimumSize: vi.fn(),
    setAspectRatio: vi.fn(),
    unmaximize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    isMaximizable: (): boolean => true,
    isFullScreenable: () => true,
    setMaximizable: vi.fn(),
    setFullScreenable: vi.fn(),
  });
  return host;
}

test("clock disables native maximize/fullscreen and restores prior capabilities on exit", async () => {
  const host = resizingHost();
  host.isMaximizable = () => false;
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", true);
  await mode.toggle();
  expect(host.setMaximizable).toHaveBeenLastCalledWith(false);
  expect(host.setFullScreenable).toHaveBeenLastCalledWith(false);
  await mode.toggle();
  expect(host.setMaximizable).toHaveBeenLastCalledWith(false);
  expect(host.setFullScreenable).toHaveBeenLastCalledWith(true);
  host.emit("closed");
});

test("clock pointer drag ignores clicks, keeps scale, releases docking and snaps on drop", async () => {
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", true);
  await mode.toggle();
  mode.setDock("bottomRight");
  const before = host.getBounds();
  mode.drag("start", { x: 500, y: 500 });
  mode.drag("end", { x: 500, y: 500 });
  expect(mode.state.clockDock).toBe("bottomRight");
  mode.drag("start", { x: 500, y: 500 });
  mode.drag("move", { x: 500 - before.x + 4, y: 420 });
  mode.drag("end", { x: 500 - before.x + 4, y: 420 });
  expect(mode.state.clockDock).toBe("left");
  expect(host.getBounds().x).toBe(12);
  expect(mode.state.pixelScale).toBe(1);
  await mode.fit("zelda", false);
  expect(host.getBounds().x).toBe(12);
  await mode.toggle();
  const normal = host.getBounds();
  mode.drag("start", { x: 500, y: 500 });
  mode.drag("move", { x: 900, y: 900 });
  mode.drag("end", { x: 900, y: 900 });
  expect(host.getBounds()).toEqual(normal);
  host.emit("closed");
});

test("frame switching preserves LCD scale and each mode restores its independent factor", async () => {
  display.density = 2;
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", true);
  const framed = host.getBounds();
  await mode.fit("zelda", false);
  expect(host.getContentSize()).toEqual([640, 512]);
  expect(mode.state.pixelScale).toBe(4);
  expect(host.getBounds().x + host.getBounds().width / 2).toBeCloseTo(
    framed.x + framed.width / 2,
    0,
  );
  await mode.setScale(3);
  await mode.toggle();
  await mode.setScale(0.5);
  await mode.fit("zelda", true);
  expect(mode.state.pixelScale).toBe(0.5);
  expect(host.getContentSize()).toEqual([183, 110]);
  await mode.toggle();
  expect(mode.state.pixelScale).toBe(3);
  expect(host.getContentSize()).toEqual([1097, 687]);
  await mode.toggle();
  expect(mode.state.pixelScale).toBe(0.5);
  host.emit("closed");
});

test("manual fractional scale survives a frame toggle instead of resetting to 1x", async () => {
  display.density = 2;
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("mario", false);
  await mode.toggle();
  host.setContentSize(100, 75);
  expect(mode.state.pixelScale).toBe(0.625);
  await mode.fit("mario", true);
  expect(mode.state.pixelScale).toBe(0.625);
  expect(host.getContentSize()).toEqual([228, 137]);
  host.emit("closed");
});

test("restored clock placement and temporary exits do not erase preferred clock mode", async () => {
  display.density = 2;
  const host = resizingHost();
  const edits: any[] = [];
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
    {
      normalScale: 2,
      clockScale: 0.5,
      clockMode: true,
      clockBounds: { x: 400, y: 300, width: 183, height: 110 },
    },
    (patch) => edits.push(patch),
  );
  await mode.fit("zelda", true);
  await mode.toggle(false);
  expect(host.getBounds()).toMatchObject({
    x: 400,
    y: 300,
    width: 183,
    height: 110,
  });
  await mode.toggle(false);
  expect(mode.state.preferredClockMode).toBe(true);
  expect(edits.some((patch) => patch.clockMode === false)).toBe(false);
  await mode.toggle();
  await mode.toggle();
  expect(mode.state.preferredClockMode).toBe(false);
  host.emit("closed");
});

test("a disconnected monitor relocates the saved clock without reducing its scale", async () => {
  display.density = 2;
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
    {
      clockScale: 0.5,
      clockBounds: {
        x: 8000,
        y: 4000,
        width: 183,
        height: 110,
        displayId: 999,
      },
    },
  );
  await mode.fit("zelda", true);
  await mode.toggle(false);
  expect(host.getBounds()).toEqual({
    x: 1417,
    y: 890,
    width: 183,
    height: 110,
  });
  expect(mode.state.pixelScale).toBe(0.5);
  host.emit("closed");
});

test("unmaximizing a frame-switched viewport restores the remembered windowed factor", async () => {
  display.density = 2;
  const host = resizingHost();
  let expanded = false;
  host.isMaximized = () => expanded;
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", true);
  expanded = true;
  host.setContentSize(1600, 1000);
  host.emit("maximize");
  const factor = mode.state.pixelScale;
  await mode.fit("zelda", false);
  expect(mode.state.pixelScale).toBe(factor);
  expect(mode.state.normalScale).toBe(4);
  expanded = false;
  host.emit("unmaximize");
  expect(mode.state.pixelScale).toBe(4);
  expect(host.getContentSize()).toEqual([640, 512]);
  host.emit("closed");
});

test("intermediate native maximize bounds cannot overwrite windowed scale", async () => {
  display.density = 2;
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", true);
  const normal = host.getBounds();
  host.getNormalBounds = () => normal;
  host.setContentSize(1644, 1013); // resize arrives before maximize flag/event
  expect(mode.state.normalScale).toBe(4);
  host.emit("closed");
});

test("idle recovery view retains its usable minimum across density changes", async () => {
  display.density = 2;
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", false);
  await mode.setScale(0.5);
  mode.setGameAvailable(false);
  expect(host.getContentSize()).toEqual([320, 280]);
  display.density = 1;
  host.emit("move");
  expect(host.getContentSize()).toEqual([320, 280]);
  expect(host.setMinimumSize).toHaveBeenLastCalledWith(320, 280);
  host.emit("closed");
});

test("frame expansion at the top edge keeps controls on screen without reducing pixels", async () => {
  display.density = 2;
  const host = resizingHost();
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
  );
  await mode.fit("zelda", false);
  host.setBounds({ y: 0 });
  await mode.fit("zelda", true);
  expect(host.getBounds().y).toBe(0);
  expect(mode.state.pixelScale).toBe(4);
  await mode.setScale(6);
  expect(mode.state.controlWidth).toBe(1600);
  expect(host.getBounds().x).toBe(0);
  expect(mode.state.pixelScale).toBe(6);
  host.emit("closed");
});

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
  await mode.setScale(1);
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
        workArea: {
          x: bounds.x + bounds.width / 2 > 0 ? 0 : -1600,
          y: 0,
          width: 1600,
          height: 1000,
        },
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
    const center = x + width / 2;
    await expect(mode.toggle()).resolves.toBeUndefined();
    expect(mode.state).toMatchObject({ pixelPerfect: true, scaleFactor: 1 });
    expect(width).toBe(731);
    expect(Math.abs(x + width / 2 - center)).toBeLessThanOrEqual(0.5);
  } finally {
    host.emit("closed");
    match.mockRestore();
  }
});

test("clock drags and docking preserve dimensions with a move-only host adapter", async () => {
  const host = resizingHost();
  const move = vi.fn((x: number, y: number) => original({ x, y }));
  const original = host.setBounds;
  host.setBounds = (next: any) =>
    original({ ...next, width: (next.width ?? host.getBounds().width) + 2 });
  const mode = new WindowMode(
    host as any,
    () => {},
    () => {},
    () => true,
    {},
    () => {},
    move,
  );
  try {
    await mode.fit("zelda", true);
    await mode.toggle();
    const initial = host.getBounds();
    mode.drag("start", { x: 400, y: 300 });
    for (let i = 1; i <= 60; i++) mode.drag("move", { x: 400 + i, y: 300 + i });
    mode.drag("end", { x: 460, y: 360 });
    mode.setDock("bottomRight");
    expect(host.getBounds().width).toBe(initial.width);
    expect(host.getBounds().height).toBe(initial.height);
    expect(move).toHaveBeenCalled();
  } finally {
    host.emit("closed");
  }
});
