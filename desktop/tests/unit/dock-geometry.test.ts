import { test, expect } from "vitest";
import { dockBounds, nearestDock } from "../../src/shared/dock-geometry";
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

test("edge docking retains the free axis, snaps only nearby edges, and supports negative monitors", () => {
  const area = { x: -1600, y: 40, width: 1600, height: 960 };
  const bounds = { x: -1595, y: 300, width: 320, height: 240 };
  expect(nearestDock(bounds, area)).toBe("left");
  expect(dockBounds(bounds, area, "left")).toEqual({ ...bounds, x: -1588 });
  expect(nearestDock({ ...bounds, y: 42 }, area)).toBe("topLeft");
  expect(nearestDock({ ...bounds, x: -800 }, area)).toBe("none");
  expect(dockBounds({ ...bounds, x: 100 }, area, "bottom")).toEqual({
    ...bounds,
    x: -332,
    y: 748,
  });
});
test("oversized windows preserve source scale with controls inside the work area", () => {
  const bounds = { x: 200, y: 200, width: 2000, height: 1000 };
  expect(
    dockBounds(bounds, { x: 0, y: 25, width: 800, height: 600 }, "bottomRight"),
  ).toEqual({ ...bounds, x: 0, y: 25 });
});
