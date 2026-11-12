import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  saveSlot,
  loadSlot,
  stateSlotTimes,
  restoreWithRollback,
} from "../../src/core/savestate-store";
import * as atomic from "../../src/core/atomic-file";
const roots: string[] = [];
const current = { kernel: "gwemu", buildSha256: "a".repeat(64) } as const;
const old = { kernel: "gwemu", buildSha256: "b".repeat(64) } as const;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), "gwemu-states-"));
  roots.push(p);
  return p;
}
test("same numbered legacy and gwemu slots remain independent", async () => {
  const d = await root();
  await saveSlot(d, 0, (p) => writeFile(p, "legacy"));
  await saveSlot(d, 0, (p) => writeFile(p, "gwemu"), current);
  expect(await readFile(await loadSlot(d, 0), "utf8")).toBe("legacy");
  expect(await readFile(await loadSlot(d, 0, current), "utf8")).toBe("gwemu");
  const manifest = JSON.parse(
    await readFile(join(d, "states-gwemu/slot-0.json"), "utf8"),
  );
  expect(manifest).toMatchObject({ version: 2, ...current });
  expect(
    JSON.parse(await readFile(join(d, "states/slot-0.json"), "utf8")).version,
  ).toBe(1);
});
test("old build remains visible, rejects load, and can be explicitly overwritten", async () => {
  const d = await root();
  await saveSlot(d, 3, (p) => writeFile(p, "old"), old);
  const previous = await loadSlot(d, 3, old);
  const savedAt = JSON.parse(
    await readFile(join(d, "states-gwemu/slot-3.json"), "utf8"),
  ).savedAt;
  expect((await stateSlotTimes(d, current))[3]).toBe(savedAt);
  await expect(loadSlot(d, 3, current)).rejects.toMatchObject({
    code: "state.incompatible",
  });
  await expect(
    saveSlot(
      d,
      3,
      async (p) => {
        await writeFile(p, "partial");
        throw Error("failed");
      },
      current,
    ),
  ).rejects.toThrow("failed");
  expect(await loadSlot(d, 3, old)).toBe(previous);
  await saveSlot(d, 3, (p) => writeFile(p, "new"), current);
  expect(await readFile(await loadSlot(d, 3, current), "utf8")).toBe("new");
  await expect(readFile(previous)).rejects.toMatchObject({ code: "ENOENT" });
});
test("wrong kernel cannot be loaded or treated as a valid timestamp", async () => {
  const d = await root();
  await saveSlot(d, 1, (p) => writeFile(p, "data"), current);
  const p = join(d, "states-gwemu/slot-1.json");
  const m = JSON.parse(await readFile(p, "utf8"));
  await writeFile(p, JSON.stringify({ ...m, kernel: "legacy" }));
  await expect(loadSlot(d, 1, current)).rejects.toMatchObject({
    code: "state.incompatible",
  });
  expect((await stateSlotTimes(d, current))[1]).toBeNull();
});
test("gwemu never falls back to legacy and recovery is retained only in its namespace", async () => {
  const d = await root();
  await saveSlot(d, 2, (p) => writeFile(p, "legacy"));
  await expect(loadSlot(d, 2, current)).rejects.toMatchObject({
    code: "state.empty",
  });
  let recovery = "";
  await expect(
    restoreWithRollback(
      d,
      "/bad",
      async (p) => {
        recovery = p;
        await writeFile(p, "recover");
      },
      async () => {
        throw Error("fail");
      },
      current,
    ),
  ).rejects.toThrow("recover");
  expect(dirname(recovery)).toBe(join(d, "states-gwemu"));
  expect(await readFile(recovery, "utf8")).toBe("recover");
  expect(
    (await readdir(join(d, "states"))).some((p) => p.startsWith("rollback-")),
  ).toBe(false);
});
test("successful recovery clears only its temporary rollback file", async () => {
  const d = await root();
  let recovery = "";
  await expect(
    restoreWithRollback(
      d,
      "/bad",
      async (p) => {
        recovery = p;
        await writeFile(p, "recover");
      },
      async (p) => {
        if (p === "/bad") throw Error("target");
      },
      current,
    ),
  ).rejects.toThrow("target");
  await expect(readFile(recovery)).rejects.toMatchObject({ code: "ENOENT" });
});
test("manifest replacement failure preserves prior gwemu reference and cleans uncommitted data", async () => {
  const d = await root();
  await saveSlot(d, 4, (p) => writeFile(p, "old"), old);
  const previous = await loadSlot(d, 4, old);
  const priorManifest = await readFile(join(d, "states-gwemu/slot-4.json"));
  vi.spyOn(atomic, "writeJson").mockRejectedValueOnce(
    Error("manifest sync failed"),
  );
  await expect(
    saveSlot(d, 4, (p) => writeFile(p, "new"), current),
  ).rejects.toThrow("manifest sync failed");
  expect(await readFile(join(d, "states-gwemu/slot-4.json"))).toEqual(
    priorManifest,
  );
  expect(await readFile(previous, "utf8")).toBe("old");
  expect(await readdir(join(d, "states-gwemu"))).toHaveLength(2);
});
test("native save returning without a file preserves original slot at flush stage", async () => {
  const d = await root();
  await saveSlot(d, 5, (p) => writeFile(p, "old"), current);
  const previous = await loadSlot(d, 5, current);
  await expect(saveSlot(d, 5, async () => {}, current)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await loadSlot(d, 5, current)).toBe(previous);
  expect(await readdir(join(d, "states-gwemu"))).toHaveLength(2);
});
