import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSlot,
  loadSlot,
  restoreWithRollback,
} from "../../src/core/savestate-store";
const identity = { kernel: "gwemu", buildSha256: "a".repeat(64) } as const;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function root() {
  const d = await mkdtemp(join(tmpdir(), "gnw-states-"));
  dirs.push(d);
  return d;
}
test("failed replacement preserves the previous slot and independent slots", async () => {
  const d = await root();
  await saveSlot(d, 0, (p) => writeFile(p, "old"), identity);
  await saveSlot(d, 9, (p) => writeFile(p, "other"), identity);
  await expect(
    saveSlot(
      d,
      0,
      async (p) => {
        await writeFile(p, "partial");
        throw Error("disk full");
      },
      identity,
    ),
  ).rejects.toThrow("disk full");
  expect(await readFile(await loadSlot(d, 0, identity), "utf8")).toBe("old");
  expect(await readFile(await loadSlot(d, 9, identity), "utf8")).toBe("other");
  await saveSlot(d, 0, (p) => writeFile(p, "new"), identity);
  expect(await readFile(await loadSlot(d, 0, identity), "utf8")).toBe("new");
});
test("a partially applied load restores live state before reporting failure", async () => {
  const d = await root();
  const live = join(d, "live");
  await writeFile(live, "current");
  const bad = join(d, "bad");
  await writeFile(bad, "broken");
  await expect(
    restoreWithRollback(
      d,
      bad,
      async (p) => writeFile(p, await readFile(live)),
      async (p) => {
        const data = await readFile(p, "utf8");
        await writeFile(live, data);
        if (data === "broken") throw Error("corrupt");
      },
      identity,
    ),
  ).rejects.toThrow("corrupt");
  expect(await readFile(live, "utf8")).toBe("current");
});
test("missing and invalid slots are rejected", async () => {
  const d = await root();
  await expect(loadSlot(d, 0, identity)).rejects.toThrow();
  await expect(
    saveSlot(d, 10, (p) => writeFile(p, "bad"), identity),
  ).rejects.toThrow();
});

test("failed rollback retains a recovery file", async () => {
  const d = await root();
  await expect(
    restoreWithRollback(
      d,
      join(d, "bad"),
      (p) => writeFile(p, "recovery"),
      async () => {
        throw Error("cannot load");
      },
      identity,
    ),
  ).rejects.toThrow("recover");
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(d, "states-gwemu"));
  expect(files.filter((f) => f.startsWith("rollback-")).length).toBe(1);
});
