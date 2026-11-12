import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJson } from "./atomic-file";
import { UserError } from "../shared/user-error";
export type StateIdentity =
  | { readonly kernel: "legacy" }
  | { readonly kernel: "gwemu"; readonly buildSha256: string };
const legacy: StateIdentity = { kernel: "legacy" };
function namespace(identity: StateIdentity) {
  if (identity.kernel === "legacy") return "states";
  if (
    identity.kernel !== "gwemu" ||
    !/^[a-f0-9]{64}$/.test(identity.buildSha256)
  )
    throw new Error("Invalid state identity");
  return "states-gwemu";
}
function slotPath(directory: string, slot: number, identity: StateIdentity) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 9)
    throw new Error("Invalid state slot");
  return join(directory, namespace(identity), `slot-${slot}.json`);
}
async function lookupSlot(
  directory: string,
  slot: number,
  identity: StateIdentity,
) {
  try {
    const manifest = JSON.parse(
      await readFile(slotPath(directory, slot, identity), "utf8"),
    );
    if (
      manifest.version !== (identity.kernel === "legacy" ? 1 : 2) ||
      typeof manifest.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(manifest.id)
    )
      throw new Error("Invalid state manifest");
    if (identity.kernel === "gwemu") {
      if (manifest.kernel !== "gwemu")
        throw new UserError("state.incompatible", { slot });
      if (
        typeof manifest.buildSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(manifest.buildSha256)
      )
        throw new Error("Invalid state manifest");
    }
    const path = join(directory, namespace(identity), manifest.id, "state.bin");
    if (!(await stat(path)).isFile()) throw new Error("Invalid state file");
    return { path, manifest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new UserError("state.empty", { slot });
    throw error;
  }
}
export async function loadSlot(
  directory: string,
  slot: number,
  identity: StateIdentity = legacy,
): Promise<string> {
  const { path, manifest } = await lookupSlot(directory, slot, identity);
  if (
    identity.kernel === "gwemu" &&
    manifest.buildSha256 !== identity.buildSha256
  )
    throw new UserError("state.incompatible", { slot });
  return path;
}
export async function saveSlot(
  directory: string,
  slot: number,
  save: (path: string) => Promise<unknown>,
  identity: StateIdentity = legacy,
) {
  const manifest = slotPath(directory, slot, identity);
  const id = randomUUID();
  const versionDir = join(directory, namespace(identity), id);
  let previous: string | undefined;
  try {
    previous = (await lookupSlot(directory, slot, identity)).path;
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
      version: identity.kernel === "legacy" ? 1 : 2,
      ...(identity.kernel === "gwemu" ? identity : {}),
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
    public recoveryPath?: string,
  ) {
    super("Failed to recover after state load");
  }
}
export async function restoreWithRollback(
  directory: string,
  path: string,
  save: (path: string) => Promise<unknown>,
  load: (path: string) => Promise<unknown>,
  identity: StateIdentity = legacy,
) {
  const rollback = join(
    directory,
    namespace(identity),
    `rollback-${randomUUID()}.bin`,
  );
  await mkdir(join(directory, namespace(identity)), { recursive: true });
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
        throw new RollbackError(original, recovery, rollback);
      }
      throw original;
    }
  } finally {
    if (!keepRecovery) await rm(rollback, { force: true }).catch(() => {});
  }
}

export async function stateSlotTimes(
  directory: string,
  identity: StateIdentity = legacy,
): Promise<(string | null)[]> {
  return Promise.all(
    Array.from({ length: 10 }, async (_, slot) => {
      try {
        const { manifest } = await lookupSlot(directory, slot, identity);
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
