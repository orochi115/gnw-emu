import {
  spawn,
  execFileSync,
  type SpawnOptions,
  type ChildProcess,
} from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
let job: ReturnType<typeof createJob> | undefined;
let closing = false;
function createJob() {
  const koffi: typeof import("koffi") = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func(
    "void * __stdcall CreateJobObjectW(void *attributes, void *name)",
  );
  const set = kernel.func(
    "int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32 size)",
  );
  const open = kernel.func(
    "void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)",
  );
  const assign = kernel.func(
    "int __stdcall AssignProcessToJobObject(void *job, void *process)",
  );
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const lastError = kernel.func("uint32 __stdcall GetLastError()");
  const handle = create(null, null);
  if (!handle) throw Error(`CreateJobObjectW failed (${lastError()})`);
  const info = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64.
  info.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
  if (!set(handle, 9, info, info.length)) {
    const code = lastError();
    close(handle);
    throw Error(`SetInformationJobObject failed (${code})`);
  }
  return {
    attach(pid: number) {
      const processHandle = open(0x101, 0, pid); // SET_QUOTA | TERMINATE.
      if (!processHandle) {
        const code = lastError();
        if (code === 87) return; // The short-lived probe has already exited.
        throw Error(`OpenProcess failed (${code})`);
      }
      try {
        if (!assign(handle, processHandle))
          throw Error(`AssignProcessToJobObject failed (${lastError()})`);
      } finally {
        close(processHandle);
      }
    },
    close() {
      close(handle);
    },
  };
}
/** Every native child belongs to this host; no global process-name kills. */
export function spawnOwnedNative(
  binary: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  if (closing) throw Error("Native process owner is closing");
  if (process.platform === "win32") job ??= createJob();
  const child = spawn(binary, args, {
    ...options,
    ...(process.platform !== "win32" ? { detached: true } : {}),
  });
  if (!child.pid) return child;
  try {
    if (job) job.attach(child.pid);
    else {
      const birth = execFileSync(
        "/bin/ps",
        ["-p", String(child.pid), "-o", "lstart="],
        { encoding: "utf8" },
      ).trim();
      const guardian = spawn(
        process.execPath,
        [join(import.meta.dirname, "native-guardian.cjs")],
        {
          stdio: ["pipe", "ignore", "ignore"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      guardian.stdin!.on("error", () => {});
      guardian.once("error", () => child.kill("SIGKILL"));
      let released = false;
      guardian.once("exit", () => {
        if (!released) child.kill("SIGKILL");
      });
      guardian.stdin!.write(JSON.stringify({ pid: child.pid, birth }) + "\n");
      child.once("exit", () => {
        released = true;
        guardian.stdin!.end("release\n");
      });
      guardian.unref();
    }
  } catch (error) {
    // Fast help probes can exit before ps observes them. Never leave a live
    // process running after a failed ownership setup.
    try {
      process.kill(child.pid, 0);
      child.kill("SIGKILL");
      throw error;
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check;
    }
  }
  return child;
}
export function closeNativeOwner() {
  closing = true;
  job?.close();
  job = undefined;
}
