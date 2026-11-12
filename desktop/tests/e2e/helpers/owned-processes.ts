import { execFileSync } from "node:child_process";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function descendants(owner: number) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 2000,
  })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const owned = new Set([owner]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  return [...owned];
}
export const processHooks = {
  descendants,
  alive,
  kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
  wait,
};

/** Discovery failure never bypasses bounded close or known owned native cleanup. */
export async function closeOwnedApplication(
  target: { pid: number; close(): Promise<void>; nativePids: Set<number> },
  evidence: Record<string, unknown>,
  hooks = processHooks,
) {
  if (target.pid === 16603 || target.nativePids.has(16603))
    throw Error("Protected legacy PID cannot belong to the test");
  const errors: unknown[] = [];
  let tree: number[] = [target.pid];
  try {
    tree = hooks.descendants(target.pid);
  } catch (error) {
    errors.push(error);
    evidence.discoveryError = String(error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      target.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Electron close exceeded 5s")),
          5000,
        );
      }),
    ]);
  } catch (error) {
    errors.push(error);
    evidence.closeError = String(error);
  } finally {
    clearTimeout(timer);
  }
  const owned = [...new Set([...tree, ...target.nativePids])];
  if (owned.includes(16603))
    throw Error("Protected legacy PID in process discovery");
  for (const pid of owned.reverse())
    if (hooks.alive(pid)) {
      try {
        hooks.kill(pid, "SIGTERM");
      } catch (error) {
        if (hooks.alive(pid)) errors.push(error);
      }
    }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && owned.some(hooks.alive)) await hooks.wait(20);
  for (const pid of owned)
    if (hooks.alive(pid)) {
      try {
        hooks.kill(pid, "SIGKILL");
      } catch (error) {
        if (hooks.alive(pid)) errors.push(error);
      }
    }
  const reaped = Date.now() + 2000;
  while (Date.now() < reaped && owned.some(hooks.alive)) await hooks.wait(20);
  evidence.ownedNativePids = [...target.nativePids];
  evidence.remainingNativePids = [...target.nativePids].filter(hooks.alive);
  evidence.remainingOwnedPids = owned.filter(hooks.alive);
  if ((evidence.remainingOwnedPids as number[]).length)
    errors.push(Error("Owned processes did not exit"));
  if (errors.length)
    throw new AggregateError(errors, "Owned application shutdown failed");
}
