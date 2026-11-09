import { join, resolve } from "node:path";
export function applicationPaths(options: {
  packaged: boolean;
  resources: string;
  project: string;
  osUserData: string;
  override?: string;
}) {
  return {
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
          process.platform === "win32"
            ? "qemu-system-arm.exe"
            : "qemu-system-arm",
        ),
  };
}
