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

/** Keep pixel size unchanged; oversized windows retain accessible top-left controls. */
export function dockBounds(
  bounds: Rectangle,
  area: Rectangle,
  corner: DockCorner,
) {
  if (corner === "none") return bounds;
  const gapX = Math.min(12, Math.max(0, (area.width - bounds.width) / 2));
  const gapY = Math.min(12, Math.max(0, (area.height - bounds.height) / 2));
  const clampX = Math.max(
    area.x + gapX,
    Math.min(bounds.x, area.x + area.width - bounds.width - gapX),
  );
  const clampY = Math.max(
    area.y + gapY,
    Math.min(bounds.y, area.y + area.height - bounds.height - gapY),
  );
  return {
    ...bounds,
    x: Math.round(
      corner === "top" || corner === "bottom"
        ? clampX
        : area.x +
            (corner.endsWith("Right") || corner === "right"
              ? Math.max(gapX, area.width - bounds.width - gapX)
              : gapX),
    ),
    y: Math.round(
      corner === "left" || corner === "right"
        ? clampY
        : area.y +
            (corner.startsWith("bottom")
              ? Math.max(gapY, area.height - bounds.height - gapY)
              : gapY),
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
