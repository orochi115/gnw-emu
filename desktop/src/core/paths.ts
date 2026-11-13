import { join, resolve } from "node:path";
import type { KernelKind } from "./kernel-backend";

export function applicationPaths(options: {
  packaged: boolean;
  resources: string;
  project: string;
  osUserData: string;
  override?: string;
  portableDirectory?: string;
  kernel?: string;
}) {
  if (options.kernel === "legacy")
    throw new Error("The legacy kernel has been retired; use gwemu");
  if (options.kernel !== undefined && options.kernel !== "gwemu")
    throw new Error("Unknown kernel selection");
  const kernel: KernelKind = "gwemu";
  return {
    kernel,
    userData: options.override
      ? resolve(options.override)
      : options.packaged
        ? join(options.portableDirectory ?? options.osUserData, "UserData")
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
          "gwemu",
          process.platform === "win32"
            ? "qemu-system-arm.exe"
            : "qemu-system-arm",
        ),
  };
}
