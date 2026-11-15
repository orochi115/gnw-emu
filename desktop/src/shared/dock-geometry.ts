export const DOCK_CORNERS = [
  "none",
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
  "left",
  "right",
  "top",
  "bottom",
] as const;
export type DockCorner = (typeof DOCK_CORNERS)[number];
type Rectangle = { x: number; y: number; width: number; height: number };

/** The same limits apply to free movement and explicit edge docking. */
export function clampBounds(bounds: Rectangle, area: Rectangle): Rectangle {
  return {
    ...bounds,
    x: Math.round(
      Math.max(
        area.x,
        Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)),
      ),
    ),
  };
}

/** Keep pixel size unchanged; oversized windows retain accessible top-left controls. */
export function dockBounds(
  bounds: Rectangle,
  area: Rectangle,
  corner: DockCorner,
) {
  if (corner === "none") return bounds;
  const right = area.x + Math.max(0, area.width - bounds.width);
  const bottom = area.y + Math.max(0, area.height - bounds.height);
  const clamped = clampBounds(bounds, area);
  return {
    ...bounds,
    x: Math.round(
      corner === "top" || corner === "bottom"
        ? clamped.x
        : corner.endsWith("Right") || corner === "right"
          ? right
          : area.x,
    ),
    y: Math.round(
      corner === "left" || corner === "right"
        ? clamped.y
        : corner.startsWith("bottom")
          ? bottom
          : area.y,
    ),
  };
}

/** Magnetism is applied at the end of a clock drag, never while freely moving. */
export function nearestDock(
  bounds: Rectangle,
  area: Rectangle,
  distance = 24,
): DockCorner {
  const left = Math.abs(bounds.x - area.x) <= distance;
  const right =
    Math.abs(bounds.x + bounds.width - area.x - area.width) <= distance;
  const top = Math.abs(bounds.y - area.y) <= distance;
  const bottom =
    Math.abs(bounds.y + bounds.height - area.y - area.height) <= distance;
  if (top && left) return "topLeft";
  if (top && right) return "topRight";
  if (bottom && left) return "bottomLeft";
  if (bottom && right) return "bottomRight";
  return left
    ? "left"
    : right
      ? "right"
      : top
        ? "top"
        : bottom
          ? "bottom"
          : "none";
}
