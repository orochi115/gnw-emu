export type ControlPage = "buttons" | "hotkeys";
interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Native settings dimensions never touch the game window's bounds. */
export function controlsWindowBounds(
  page: ControlPage,
  parent: Rectangle,
  area: Rectangle,
  remembered?: Rectangle,
): Rectangle {
  const size =
    remembered ??
    (page === "buttons"
      ? { width: 1240, height: 820 }
      : { width: 780, height: 620 });
  const width = Math.min(size.width, area.width),
    height = Math.min(size.height, area.height);
  const x = remembered?.x ?? Math.round(parent.x + (parent.width - width) / 2);
  const y =
    remembered?.y ?? Math.round(parent.y + (parent.height - height) / 2);
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width,
    height,
  };
}
