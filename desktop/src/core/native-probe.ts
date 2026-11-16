import { spawnOwnedNative } from "./owned-process";
import { UserError } from "../shared/user-error";
export async function executeNativeProbe(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  phase: string,
) {
  let stderr = "",
    stdout = "";
  const child = spawnOwnedNative(binary, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = (old: string, chunk: Buffer) =>
    (old + chunk.toString()).slice(-65536);
  child.stdout?.on("data", (chunk) => (stdout = output(stdout, chunk)));
  child.stderr?.on("data", (chunk) => (stderr = output(stderr, chunk)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (detail: string) =>
        reject(new UserError("error.kernelConnection", { phase, detail }));
      child.once("error", (error) =>
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new UserError("error.kernelBuild")
            : new UserError("error.kernelConnection", {
                phase,
                detail: error.message,
              }),
        ),
      );
      child.once("exit", (code, signal) =>
        !timedOut && code === 0
          ? resolve()
          : fail(
              `${timedOut ? "timeout; " : ""}exit=${code}; signal=${signal}; ${stderr.slice(-4096)}`,
            ),
      );
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 5000);
    });
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
