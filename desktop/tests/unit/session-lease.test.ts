import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease } from "../../src/core/session-lease";
test("application lease is exclusive and can only release its owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-lease-"));
  try {
    const first = await acquireLease(root, "one");
    await expect(acquireLease(root, "two")).rejects.toMatchObject({
      code: expect.stringMatching(/^error.lease/),
    });
    await first.release();
    const second = await acquireLease(root, "two");
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent recovery of a dead owner grants one lease and preserves a live child", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "gnw-dead-"));
  try {
    await mkdir(join(root, ".lease"));
    await writeFile(
      join(root, ".lease", "owner.json"),
      JSON.stringify({ pid: 2147483647, token: "old" }),
    );
    const results = await Promise.allSettled([
      acquireLease(root, "one"),
      acquireLease(root, "two"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLease>>>;
    await winner.value.release();
    await mkdir(join(root, ".lease"));
    await writeFile(
      join(root, ".lease", "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        childPid: process.pid,
        token: "orphan",
      }),
    );
    await expect(acquireLease(root, "new")).rejects.toMatchObject({
      code: expect.stringMatching(/^error.lease/),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
