export const DOCK_CORNERS = [
  "none",
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
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
  return {
    ...bounds,
    x: Math.round(
      area.x +
        (corner.endsWith("Right")
          ? Math.max(gapX, area.width - bounds.width - gapX)
          : gapX),
    ),
    y: Math.round(
      area.y +
        (corner.startsWith("bottom")
          ? Math.max(gapY, area.height - bounds.height - gapY)
          : gapY),
    ),
  };
}
