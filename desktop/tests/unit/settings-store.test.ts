import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, updateSettings } from "../../src/core/settings-store";
import { defaultControls } from "../../src/shared/controls";
test("old settings gain controls and concurrent preference writes preserve the actual JSON mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-controls-settings-"));
  try {
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ formatVersion: 1, audio: false, language: "en" }),
    );
    expect((await loadSettings(root)).controls).toEqual(defaultControls());
    const controls = defaultControls();
    controls.bindings[0].inputs = [{ kind: "keyboard", code: "KeyJ" }];
    await Promise.all([
      updateSettings(root, { controls }),
      updateSettings(root, { showChassis: false }),
    ]);
    const saved = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    );
    expect(saved.controls).toEqual(controls);
    expect(await loadSettings(root)).toMatchObject({
      controls,
      audio: false,
      language: "en",
      showChassis: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("chassis defaults on and serialized updates preserve language/audio", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-settings-"));
  try {
    expect((await loadSettings(root)).showChassis).toBe(true);
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({
        formatVersion: 1,
        language: "zh-CN",
        audio: false,
        realtime: false,
      }),
    );
    await Promise.all([
      updateSettings(root, { showChassis: false }),
      updateSettings(root, { realtime: true }),
    ]);
    expect(await loadSettings(root)).toMatchObject({
      showChassis: false,
      language: "zh-CN",
      audio: false,
      realtime: true,
    });
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8"))
        .showChassis,
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid settings updates leave the persisted preference untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-settings-"));
  try {
    await loadSettings(root);
    const before = await readFile(join(root, "settings.json"), "utf8");
    await expect(
      updateSettings(root, { showChassis: "invalid" } as any),
    ).rejects.toThrow();
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(before);
    await updateSettings(root, { showChassis: false });
    expect((await loadSettings(root)).showChassis).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("per-mode fractional scales, clock preference and placement survive unrelated updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-settings-"));
  try {
    expect(await loadSettings(root)).toMatchObject({
      normalScale: 4,
      clockScale: 1,
      clockMode: false,
    });
    const clockBounds = {
      x: 100,
      y: 200,
      width: 183,
      height: 110,
      displayId: 42,
    };
    await Promise.all([
      updateSettings(root, {
        normalScale: 3,
        clockScale: 0.625,
        clockMode: true,
        clockBounds,
      }),
      updateSettings(root, { showChassis: false, language: "en" }),
    ]);
    expect(await loadSettings(root)).toMatchObject({
      normalScale: 3,
      clockScale: 0.625,
      clockMode: true,
      clockBounds,
      showChassis: false,
      language: "en",
    });
    await expect(updateSettings(root, { clockScale: 0 })).rejects.toThrow();
    expect((await loadSettings(root)).clockScale).toBe(0.625);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing mappings gain state shortcuts once, without replacing custom mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-state-controls-"));
  try {
    const old = defaultControls();
    old.bindings = old.bindings.filter((b) => !b.target.startsWith("state."));
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ formatVersion: 1, controls: old }),
    );
    const loaded = await loadSettings(root);
    expect(
      loaded.controls.bindings.filter((b) => b.target.startsWith("state."))
        .length,
    ).toBe(4);
    expect(
      loaded.controls.bindings.filter((b) => !b.target.startsWith("state.")),
    ).toEqual(old.bindings);
    loaded.controls.bindings = loaded.controls.bindings.filter(
      (b) => !b.target.startsWith("state."),
    );
    await updateSettings(root, { controls: loaded.controls });
    expect(
      (await loadSettings(root)).controls.bindings.some((b) =>
        b.target.startsWith("state."),
      ),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
