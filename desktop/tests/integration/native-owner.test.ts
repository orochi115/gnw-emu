import { test, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";

test("forced host termination ends its owned native child", async () => {
  await mkdir(resolve("out"), { recursive: true });
  const directory = await mkdtemp(resolve("out/native-owner-"));
  let nativePid: number | undefined;
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  let parent: ReturnType<typeof spawn> | undefined;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      if (
        process.platform !== "win32" &&
        execFileSync("/bin/ps", ["-p", String(pid), "-o", "state="], {
          encoding: "utf8",
        })
          .trim()
          .startsWith("Z")
      )
        return false;
      return true;
    } catch {
      return false;
    }
  };
  try {
    const entry = join(directory, "entry.mjs");
    await writeFile(
      entry,
      `import {spawnOwnedNative} from ${JSON.stringify(resolve("src/core/owned-process.ts"))}; const child=spawnOwnedNative(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']}); console.log(child.pid); setInterval(()=>{},1000);`,
    );
    await build({
      entryPoints: [entry],
      outfile: join(directory, "parent.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
    });
    await copyFile(
      resolve("src/core/native-guardian.cjs"),
      join(directory, "native-guardian.cjs"),
    );
    parent = spawn(process.execPath, [join(directory, "parent.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    nativePid = await new Promise<number>((accept, reject) => {
      const timer = setTimeout(() => reject(Error("No owned child PID")), 5000);
      parent!.stdout!.once("data", (chunk) => {
        clearTimeout(timer);
        accept(Number(String(chunk).trim()));
      });
      parent!.once("error", reject);
    });
    expect(nativePid).toBeGreaterThan(0);
    expect(alive(nativePid)).toBe(true);
    const exited = new Promise((resolveExit) =>
      parent!.once("exit", resolveExit),
    );
    parent.kill("SIGKILL");
    await exited;
    for (let i = 0; i < 50 && alive(nativePid); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(alive(nativePid)).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    unrelated.kill("SIGKILL");
    parent?.kill("SIGKILL");
    if (nativePid && alive(nativePid)) process.kill(nativePid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
