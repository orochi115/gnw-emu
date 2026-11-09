import mario from "../assets/chassis/mario/skin.json";
import zelda from "../assets/chassis/zelda/skin.json";
export interface SkinButton {
  id: string;
  bit: number;
  shape: {
    kind: string;
    bounds?: number[];
    points?: number[][];
    radius?: number;
  };
  spriteRect: { x: number; y: number; width: number; height: number };
  states: { normal: string; hover: string; pressed: string };
}
export interface Skin {
  model: string;
  size: { width: number; height: number };
  screen: { x: number; y: number; width: number; height: number };
  buttons: SkinButton[];
}
export const skins: Record<"mario" | "zelda", Skin> = { mario, zelda };
const images = import.meta.glob<string>("../assets/chassis/*/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
export function skinImage(skin: Skin, filename: string) {
  return images[`../assets/chassis/${skin.model}/${filename}`];
}
