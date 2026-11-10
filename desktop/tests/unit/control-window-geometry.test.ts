import { expect, test } from "vitest";
import { controlsWindowBounds } from "../../src/main/control-window-geometry";

test("settings windows use different native sizes and stay inside a negative-origin workarea", () => {
  const area = { x: -1440, y: 0, width: 1440, height: 900 };
  const parent = { x: -200, y: 750, width: 900, height: 600 };
  const buttons = controlsWindowBounds("buttons", parent, area);
  const hotkeys = controlsWindowBounds("hotkeys", parent, area);
  expect(buttons.width).toBeGreaterThan(hotkeys.width);
  expect(buttons.height).toBeGreaterThan(hotkeys.height);
  for (const bounds of [buttons, hotkeys]) {
    expect(bounds.x).toBeGreaterThanOrEqual(area.x);
    expect(bounds.y).toBeGreaterThanOrEqual(area.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height);
  }
  expect(parent).toEqual({ x: -200, y: 750, width: 900, height: 600 });
});
test("remembered sizes are fitted to the current display, including small screens", () => {
  expect(
    controlsWindowBounds(
      "buttons",
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 3000, y: 3000, width: 1800, height: 1400 },
    ),
  ).toEqual({ x: 0, y: 0, width: 800, height: 600 });
});
