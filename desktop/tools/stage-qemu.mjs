/** Stage the native executable outside asar. macOS dependencies are relocatable;
 * Linux uses $ORIGIN/lib. Windows accepts its native build's DLL directory. */
import {
  copyFile,
  mkdir,
  readdir,
  chmod,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, basename, dirname } from "node:path";
import { validateNativeSource, sha256 } from "./native-stage-manifest.mjs";
const source = resolve(
  process.env.GNW_QEMU_BINARY ??
    "../build/gwemu/" +
      (process.platform === "win32"
        ? "qemu-system-arm.exe"
        : "qemu-system-arm"),
);
const sourceManifestPath = resolve(
  process.env.GWEMU_BUILD_MANIFEST ??
    join(dirname(source), "gnw-build-manifest.json"),
);
const provenance = await validateNativeSource(source, sourceManifestPath);
const expectedName =
  process.platform === "win32" ? "qemu-system-arm.exe" : "qemu-system-arm";
if (basename(source) !== expectedName)
  throw new Error("Cannot stage gwemu: unexpected executable name");
const directory = resolve(process.env.GNW_STAGE_DIR ?? "resources/qemu");
await rm(directory, { recursive: true, force: true });
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
await copyFile(sourceManifestPath, join(directory, "gnw-build-manifest.json"));
const libraries = {};
for (const name of await readdir(join(directory, "lib")))
  libraries[`lib/${name}`] = await sha256(join(directory, "lib", name));
if (process.platform === "win32") {
  for (const name of await readdir(directory))
    if (name.toLowerCase().endsWith(".dll"))
      libraries[name] = await sha256(join(directory, name));
}
await writeFile(
  join(directory, "gnw-package-manifest.json"),
  JSON.stringify(
    {
      formatVersion: 1,
      kernel: "gwemu",
      platform: process.platform,
      architecture: process.arch,
      revision: provenance.revision,
      sourceSha256: provenance.sourceSha256,
      sourceManifestSha256: provenance.sourceManifestSha256,
      stagedSha256: await sha256(output),
      executable: basename(output),
      libraries,
      configureArgs: provenance.sourceManifest.configureArgs,
      tools: provenance.sourceManifest.tools,
      capabilities: provenance.capabilities,
    },
    null,
    2,
  ) + "\n",
);
// The GNW machine needs no bundled firmware ROMs or user images.
if (!existsSync(output)) throw new Error("Missing staged QEMU");
process.stderr.write(
  `Staged ${basename(source)} and ${Object.keys(libraries).length} libraries\n`,
);
