import { UserError } from "../shared/user-error";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "./atomic-file";
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function acquireLease(directory: string, token: string) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, ".lease");
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recovery = join(directory, ".recovery");
    try {
      await mkdir(recovery);
    } catch {
      throw new UserError("error.leaseRecovery");
    }
    try {
      let owner: { pid: number; childPid?: number; token: string };
      try {
        owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      } catch {
        throw new UserError("error.leaseUnknown");
      }
      if (
        !Number.isInteger(owner.pid) ||
        alive(owner.pid) ||
        (owner.childPid && alive(owner.childPid))
      )
        throw new UserError("error.leaseOccupied");
      // Recovery itself is serialized. Re-read under that guard before
      // removal, so a second recovery cannot remove the new owner's lease.
      await rm(path, { recursive: true });
      await mkdir(path);
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  const owner = {
    pid: process.pid,
    token,
    childPid: undefined as number | undefined,
  };
  await writeJson(join(path, "owner.json"), owner);
  return {
    async attach(pid: number) {
      owner.childPid = pid;
      await writeJson(join(path, "owner.json"), owner);
    },
    async release() {
      const current = JSON.parse(
        await readFile(join(path, "owner.json"), "utf8"),
      );
      if (current.token !== token) throw new Error("Lease ownership changed");
      await rm(path, { recursive: true });
    },
  };
}
