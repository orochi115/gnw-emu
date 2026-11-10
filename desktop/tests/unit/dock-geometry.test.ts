import { test, expect } from "vitest";
import { dockBounds } from "../../src/shared/dock-geometry";
test("all corners respect negative monitor origin and its available work area", () => {
  const area = { x: -1600, y: 40, width: 1600, height: 960 };
  const bounds = { x: -400, y: 300, width: 320, height: 240 };
  expect(dockBounds(bounds, area, "topLeft")).toEqual({
    x: -1588,
    y: 52,
    width: 320,
    height: 240,
  });
  expect(dockBounds(bounds, area, "topRight")).toEqual({
    x: -332,
    y: 52,
    width: 320,
    height: 240,
  });
  expect(dockBounds(bounds, area, "bottomLeft")).toEqual({
    x: -1588,
    y: 748,
    width: 320,
    height: 240,
  });
  expect(dockBounds(bounds, area, "bottomRight")).toEqual({
    x: -332,
    y: 748,
    width: 320,
    height: 240,
  });
  expect(dockBounds(bounds, area, "none")).toEqual(bounds);
});
test("oversized windows preserve source scale with controls inside the work area", () => {
  const bounds = { x: 200, y: 200, width: 2000, height: 1000 };
  expect(
    dockBounds(bounds, { x: 0, y: 25, width: 800, height: 600 }, "bottomRight"),
  ).toEqual({ ...bounds, x: 0, y: 25 });
});
