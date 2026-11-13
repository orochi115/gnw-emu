import mario from "../renderer/assets/chassis/mario/skin.json";
import zelda from "../renderer/assets/chassis/zelda/skin.json";

const skins = { mario, zelda };
export const LCD_WIDTH = 320;
export const LCD_HEIGHT = 240;
/** Bounds are logical pixels; the LCD is 320×240 output pixels at any density. */
export function clockGeometry(
  model: "mario" | "zelda" | undefined,
  frame: boolean,
  density: number,
  factor = 1,
) {
  const skin = model && frame ? skins[model] : undefined;
  const photoScale = skin
    ? (LCD_WIDTH * factor) / (skin.screen.width * density)
    : factor / density;
  const layoutWidth = (skin?.size.width ?? LCD_WIDTH) * photoScale;
  const layoutHeight = (skin?.size.height ?? LCD_HEIGHT) * photoScale;
  return {
    width: Math.ceil(layoutWidth),
    height: Math.ceil(layoutHeight),
    layoutWidth,
    layoutHeight,
    scale: factor / density,
    ratio: skin ? skin.size.width / skin.size.height : 4 / 3,
  };
}

export const SCALE_PRESETS = [0.5, 1, 2, 3, 4, 5, 6] as const;
export const scaleMenuId = (factor: number) =>
  `view.scale.${factor === 0.5 ? "half" : factor}`;
