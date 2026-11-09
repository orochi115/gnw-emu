import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, updateSettings } from "../../src/core/settings-store";
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
