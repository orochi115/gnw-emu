import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RecentRoms } from "../../src/core/recent-roms";
import { loadSettings, updateSettings } from "../../src/core/settings-store";

test("history persists bounded unique paths without replacing other preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-recent-"));
  try {
    const initial = await loadSettings(root);
    expect(initial.recentRoms).toEqual([]);
    const history = new RecentRoms(initial.recentRoms, (recentRoms) =>
      updateSettings(root, { recentRoms }),
    );
    await updateSettings(root, { clockScale: 0.5, showChassis: false });
    for (let i = 0; i < 12; i++)
      await history.record(resolve(root, `${i}.gnw.json`));
    await history.record(resolve(root, "5.gnw.json"));
    expect(history.entries).toHaveLength(10);
    expect(history.entries[0]).toBe(join(root, "5.gnw.json"));
    expect(new Set(history.entries).size).toBe(10);
    expect(history.entries).not.toContain(join(root, "1.gnw.json"));
    const saved = await loadSettings(root);
    expect(saved).toMatchObject({
      recentRoms: history.entries,
      clockScale: 0.5,
      showChassis: false,
    });
    const restarted = new RecentRoms(saved.recentRoms, (recentRoms) =>
      updateSettings(root, { recentRoms }),
    );
    await restarted.clear();
    expect((await loadSettings(root)).recentRoms).toEqual([]);
    expect((await loadSettings(root)).clockScale).toBe(0.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed persistence preserves published history and later changes recover", async () => {
  let fail = true;
  const original = resolve("a.gnw.json");
  const history = new RecentRoms([original], async () => {
    if (fail) throw Error("disk unavailable");
  });
  await expect(history.record(resolve("b.gnw.json"))).rejects.toThrow(
    "disk unavailable",
  );
  expect(history.entries).toEqual([original]);
  fail = false;
  await history.record(resolve("c.gnw.json"));
  expect(history.entries).toEqual([resolve("c.gnw.json"), original]);
});
