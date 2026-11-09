import mario from "../renderer/assets/chassis/mario/skin.json";
import zelda from "../renderer/assets/chassis/zelda/skin.json";

const skins = { mario, zelda };
/** Bounds are logical pixels; the LCD is 320×240 output pixels at any density. */
export function clockGeometry(
  model: "mario" | "zelda" | undefined,
  frame: boolean,
  density: number,
) {
  const skin = model && frame ? skins[model] : undefined;
  const scale = skin ? 320 / (skin.screen.width * density) : 1 / density;
  return {
    width: Math.ceil((skin?.size.width ?? 320) * scale),
    height: Math.ceil((skin?.size.height ?? 240) * scale),
    ratio: skin ? skin.size.width / skin.size.height : 4 / 3,
  };
}
