import { expect, test } from "vitest";
import { clockGeometry } from "../../src/shared/clock-geometry";

test("Retina plain 1:1 uses 160×120 logical pixels; skins size from the same LCD", () => {
  expect(clockGeometry("zelda", false, 2)).toMatchObject({
    width: 160,
    height: 120,
  });
  expect(clockGeometry("zelda", true, 2)).toMatchObject({
    width: 366,
    height: 219,
  });
  expect(clockGeometry("mario", true, 2)).toMatchObject({
    width: 364,
    height: 218,
  });
});

test("density changes and fractional density never round the source LCD down", () => {
  for (const density of [1, 1.25, 1.5, 2, 3, 4]) {
    const plain = clockGeometry("zelda", false, density);
    expect(plain.width * density).toBeGreaterThanOrEqual(320);
    expect(plain.height * density).toBeGreaterThanOrEqual(240);
    expect(plain.width - 320 / density).toBeLessThan(1);
    expect(plain.height - 240 / density).toBeLessThan(1);
  }
});

test("half and integer factors size the same LCD with or without either frame", () => {
  for (const model of ["mario", "zelda"] as const)
    for (const factor of [0.5, 1, 2, 3, 6]) {
      const plain = clockGeometry(model, false, 2, factor);
      expect(plain.width).toBe(160 * factor);
      expect(plain.height).toBe(120 * factor);
      const framed = clockGeometry(model, true, 2, factor);
      expect(framed.width).toBeGreaterThan(plain.width);
      expect(framed.scale).toBe(factor / 2);
    }
});
