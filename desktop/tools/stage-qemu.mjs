/** Stage the native executable outside asar. macOS dependencies are relocatable;
 * Linux uses $ORIGIN/lib. Windows accepts its native build's DLL directory. */
import { copyFile, mkdir, readdir, chmod, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, basename } from "node:path";
const source = resolve(
  process.env.GNW_QEMU_BINARY ??
    "../build/" +
      (process.platform === "win32"
        ? "qemu-system-arm.exe"
        : "qemu-system-arm"),
);
const directory = resolve("resources/qemu");
await mkdir(join(directory, "lib"), { recursive: true });
const output = join(directory, basename(source));
await copyFile(source, output);
await chmod(output, 0o755);
const copied = new Map();
async function stage(path, isBinary = false) {
  if (process.platform === "darwin") {
    const lines = execFileSync("otool", ["-L", path], { encoding: "utf8" })
      .split("\n")
      .slice(1);
    for (const line of lines) {
      const dependency = line.trim().split(" (")[0];
      if (
        !dependency.startsWith("/") ||
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/")
      )
        continue;
      const original = await realpath(dependency);
      const name = basename(dependency);
      if (copied.has(name) && copied.get(name) !== original)
        throw new Error("Conflicting library: " + name);
      const target = join(directory, "lib", name);
      if (!copied.has(name)) {
        copied.set(name, original);
        await copyFile(original, target);
        await chmod(target, 0o755);
        await stage(target);
      }
      execFileSync("install_name_tool", [
        "-change",
        dependency,
        (isBinary ? "@loader_path/lib/" : "@loader_path/") + name,
        path,
      ]);
    }
    if (!isBinary)
      execFileSync("install_name_tool", [
        "-id",
        "@loader_path/" + basename(path),
        path,
      ]);
    execFileSync("codesign", ["--force", "--sign", "-", path], {
      stdio: "pipe",
    });
  } else if (process.platform === "linux") {
    const deps = execFileSync("ldd", [path], { encoding: "utf8" }).split("\n");
    for (const line of deps) {
      const dependency = line.match(/=> (\/[^ ]+)/)?.[1];
      if (
        !dependency ||
        /^lib(c|m|pthread|dl|rt|resolv)\.so/.test(basename(dependency))
      )
        continue;
      const name = basename(dependency);
      if (!copied.has(name)) {
        copied.set(name, dependency);
        const target = join(directory, "lib", name);
        await copyFile(dependency, target);
        await stage(target);
      }
    }
    execFileSync("patchelf", [
      "--set-rpath",
      isBinary ? "$ORIGIN/lib" : "$ORIGIN",
      path,
    ]);
  }
}
if (process.platform === "win32") {
  const dllDirectory = process.env.GNW_QEMU_LIB_DIR;
  if (!dllDirectory)
    throw new Error(
      "Set GNW_QEMU_LIB_DIR to the native QEMU build DLL directory",
    );
  for (const name of await readdir(dllDirectory))
    if (name.toLowerCase().endsWith(".dll"))
      await copyFile(join(dllDirectory, name), join(directory, name));
} else await stage(output, true);
// QEMU does not need firmware ROMs for GNW, and no user images are packaged.
if (!existsSync(output)) throw new Error("Missing staged QEMU");
process.stderr.write(
  `Staged ${basename(source)} and ${copied.size} libraries\n`,
);
