import {
  join,
  resolve,
  dirname,
  basename,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { realpathSync } from "node:fs";
import type { KernelKind } from "./kernel-backend";

function canonical(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(resolved);
    if (parent === resolved) throw error;
    return join(canonical(parent), basename(resolved));
  }
}
function contains(parent: string, child: string) {
  if (process.platform === "darwin" || process.platform === "win32") {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  const path = relative(parent, child);
  return (
    !path ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
export function applicationPaths(options: {
  packaged: boolean;
  resources: string;
  project: string;
  osUserData: string;
  override?: string;
  kernel?: string;
}) {
  const kernel: KernelKind =
    options.kernel === undefined ? "legacy" : (options.kernel as KernelKind);
  if (kernel !== "legacy" && kernel !== "gwemu")
    throw new Error("Unknown kernel selection");
  if (kernel === "gwemu") {
    if (options.packaged)
      throw new Error("gwemu preview is available only in development");
    if (!options.override)
      throw new Error("gwemu requires an explicit isolated --user-data-dir");
    const candidate = canonical(options.override);
    for (const path of [
      join(options.project, "UserData"),
      join(options.osUserData, "UserData"),
    ]) {
      const protectedData = canonical(path);
      if (
        contains(protectedData, candidate) ||
        contains(candidate, protectedData)
      )
        throw new Error(
          "gwemu requires an isolated directory outside product UserData",
        );
    }
  }
  return {
    kernel,
    userData: options.override
      ? resolve(options.override)
      : options.packaged
        ? join(options.osUserData, "UserData")
        : join(options.project, "UserData"),
    qemu: options.packaged
      ? join(
          options.resources,
          "qemu",
          process.platform === "win32"
            ? "qemu-system-arm.exe"
            : "qemu-system-arm",
        )
      : join(
          options.project,
          "build",
          ...(kernel === "gwemu" ? ["gwemu-manager-ram"] : []),
          process.platform === "win32"
            ? "qemu-system-arm.exe"
            : "qemu-system-arm",
        ),
  };
}
