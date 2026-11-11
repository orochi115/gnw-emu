import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJson } from "./atomic-file";
import { UserError } from "../shared/user-error";
function slotPath(directory: string, slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 9)
    throw new Error("Invalid state slot");
  return join(directory, "states", `slot-${slot}.json`);
}
export async function loadSlot(
  directory: string,
  slot: number,
): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(slotPath(directory, slot), "utf8"),
    );
    if (
      manifest.version !== 1 ||
      typeof manifest.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(manifest.id)
    )
      throw new Error("Invalid state manifest");
    const path = join(directory, "states", manifest.id, "state.bin");
    if (!(await stat(path)).isFile()) throw new Error("Invalid state file");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new UserError("state.empty", { slot });
    throw error;
  }
}
export async function saveSlot(
  directory: string,
  slot: number,
  save: (path: string) => Promise<unknown>,
) {
  const manifest = slotPath(directory, slot);
  const id = randomUUID();
  const versionDir = join(directory, "states", id);
  let previous: string | undefined;
  try {
    previous = await loadSlot(directory, slot);
  } catch (e) {
    if (!(e instanceof UserError && e.code === "state.empty")) throw e;
  }
  await mkdir(versionDir, { recursive: true });
  let committed = false;
  try {
    const path = join(versionDir, "state.bin");
    await save(path);
    const file = await open(path, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await writeJson(manifest, {
      version: 1,
      id,
      savedAt: new Date().toISOString(),
    });
    committed = true;
  } finally {
    if (!committed) await rm(versionDir, { recursive: true, force: true });
  }
  if (previous)
    await rm(dirname(previous), { recursive: true, force: true }).catch(
      () => {},
    );
}
export class RollbackError extends Error {
  constructor(
    public original: unknown,
    public rollback: unknown,
  ) {
    super("Failed to recover after state load");
  }
}
export async function restoreWithRollback(
  directory: string,
  path: string,
  save: (path: string) => Promise<unknown>,
  load: (path: string) => Promise<unknown>,
) {
  const rollback = join(directory, "states", `rollback-${randomUUID()}.bin`);
  await mkdir(join(directory, "states"), { recursive: true });
  let keepRecovery = false;
  try {
    await save(rollback);
    try {
      await load(path);
    } catch (original) {
      try {
        await load(rollback);
      } catch (recovery) {
        keepRecovery = true;
        throw new RollbackError(original, recovery);
      }
      throw original;
    }
  } finally {
    if (!keepRecovery) await rm(rollback, { force: true }).catch(() => {});
  }
}

export async function stateSlotTimes(
  directory: string,
): Promise<(string | null)[]> {
  return Promise.all(
    Array.from({ length: 10 }, async (_, slot) => {
      try {
        const manifest = JSON.parse(
          await readFile(slotPath(directory, slot), "utf8"),
        );
        await loadSlot(directory, slot);
        return typeof manifest.savedAt === "string" &&
          Number.isFinite(Date.parse(manifest.savedAt))
          ? manifest.savedAt
          : null;
      } catch {
        return null;
      }
    }),
  );
}
