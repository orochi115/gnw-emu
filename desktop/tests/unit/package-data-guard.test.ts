import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("packaging refuses a live data directory before clearing any output files", async () => {
  const guard = createRequire(import.meta.url)(
    "../../tools/protect-package-data.cjs",
  );
  const root = await mkdtemp(join(tmpdir(), "gnw-package-guard-"));
  try {
    await expect(guard({ appOutDir: root })).resolves.toBeUndefined();
    await mkdir(join(root, "UserData"));
    await writeFile(join(root, "UserData/settings.json"), "saved settings");
    await writeFile(join(root, "old-package"), "old app");
    await expect(guard({ appOutDir: root })).rejects.toThrow(/UserData/);
    expect(await readFile(join(root, "UserData/settings.json"), "utf8")).toBe(
      "saved settings",
    );
    expect(await readFile(join(root, "old-package"), "utf8")).toBe("old app");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
