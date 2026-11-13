/** Collect the complete MinGW runtime import closure beside a native EXE.
 * Windows system libraries remain provided by the OS. No MSYS DLL is allowed. */
import { spawn } from "node:child_process";
import { copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function collectWindowsDlls(binary, libraryDirectory) {
  binary = resolve(binary);
  libraryDirectory = resolve(libraryDirectory);
  const destination = dirname(binary);
  const names = new Map(
    (await readdir(libraryDirectory)).map((name) => [
      name.toLowerCase(),
      join(libraryDirectory, name),
    ]),
  );
  // Meson fallbacks (e.g. libepoxy) produce DLLs inside the build tree.
  // Prefer the library actually linked by this build over a toolchain copy.
  async function findBuiltDlls(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await findBuiltDlls(path);
      else if (item.isFile() && item.name.toLowerCase().endsWith(".dll"))
        names.set(item.name.toLowerCase(), path);
    }
  }
  const subprojects = join(destination, "subprojects");
  if (existsSync(subprojects)) await findBuiltDlls(subprojects);
  const objdump = join(libraryDirectory, "objdump.exe");
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const visited = new Set();
  const libraries = [];
  async function visit(file) {
    const key = basename(file).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const imports = await new Promise((accept, reject) => {
      const child = spawn(objdump, ["-p", file], { windowsHide: true });
      const found = new Set();
      let pending = "",
        errors = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop();
        for (const line of lines) {
          const match = line.match(/DLL Name:\s*(\S+)/);
          if (match) found.add(match[1]);
        }
      });
      child.stderr.on("data", (chunk) => {
        if (errors.length < 4096) errors += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? accept([...found])
          : reject(new Error(`objdump failed (${code}): ${errors}`)),
      );
    });
    for (const name of imports) {
      const lower = name.toLowerCase();
      if (lower.startsWith("msys-"))
        throw new Error(
          `Native Windows build depends on MSYS runtime: ${name}`,
        );
      const original = names.get(lower);
      if (!original) {
        if (/^(api|ext)-ms-win-/i.test(name) || existsSync(join(system, name)))
          continue;
        throw new Error(`Missing runtime DLL: ${name} (imported by ${file})`);
      }
      const source = original;
      const target = join(destination, basename(original));
      if (!visited.has(lower)) {
        if (resolve(source).toLowerCase() !== resolve(target).toLowerCase())
          await copyFile(source, target);
        libraries.push(basename(original));
        await visit(target);
      }
    }
  }
  await visit(binary);
  return libraries;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [binary, directory] = process.argv.slice(2);
  if (!binary || !directory)
    throw new Error("Usage: node collect-windows-dlls.mjs EXE UCRT64_BIN");
  const libraries = await collectWindowsDlls(binary, directory);
  process.stdout.write(
    `Collected ${libraries.length} DLLs: ${libraries.join(", ")}\n`,
  );
}
