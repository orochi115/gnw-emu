/** Verify the pinned gwemu build before copying any generated package files. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function validateNativeSource(binary, manifestPath) {
  try {
    const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const pinned = execFileSync(
      "git",
      ["-C", project, "ls-tree", "HEAD", "externals/gwemu"],
      { encoding: "utf8" },
    ).match(/^160000 commit ([a-f0-9]{40})\t/)?.[1];
    const checkout = resolve(project, "externals/gwemu");
    const revision = execFileSync(
      "git",
      ["-C", checkout, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const dirty = execFileSync(
      "git",
      ["-C", checkout, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8" },
    ).trim();
    if (
      !pinned ||
      revision !== pinned ||
      sourceManifest.revision !== pinned ||
      dirty ||
      sourceManifest.formatVersion !== 1 ||
      sourceManifest.sourceDirty !== false ||
      (await realpath(sourceManifest.source)) !== (await realpath(checkout))
    )
      throw new Error("source must match the pinned clean gwemu checkout");
    const expectedArgs = [
      "--target-list=arm-softmmu",
      "--disable-docs",
      "--disable-werror",
      "--disable-tools",
      "--disable-guest-agent",
      "--disable-vnc",
      "--disable-sdl",
      "--disable-sdl-image",
      "--disable-gtk",
    ];
    if (
      JSON.stringify(sourceManifest.configureArgs) !==
        JSON.stringify(expectedArgs) ||
      !sourceManifest.tools?.compiler?.version ||
      !sourceManifest.compilers?.host?.c ||
      !sourceManifest.host?.system ||
      !sourceManifest.python
    )
      throw new Error(
        "missing or unsupported build configuration/toolchain provenance",
      );
    const sourceSha256 = await sha256(binary);
    if (
      sourceManifest.artifact?.sha256 !== sourceSha256 ||
      (await realpath(sourceManifest.artifact.path)) !==
        (await realpath(binary))
    )
      throw new Error("binary does not match the build manifest");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(GNW_|GWEMU_)/.test(key),
      ),
    );
    const help = (args) =>
      execFileSync(binary, ["-display", "none", ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const machine = help(["-M", "gnw-h7b0,help"]);
    const soc = help(["-device", "gnw-h7b0-soc,help"]);
    const audio = help(["-device", "gnw-h7b0-sai1,help"]);
    const gdb = help(["-help"]).includes("-gdb");
    const required = [
      "frame-endpoint",
      "session-lock",
      "sd-wiring",
      "power-model",
      "battery-present",
      "usb-power",
    ];
    if (
      !gdb ||
      !required.every((name) => machine.includes(name)) ||
      !/\buid\b/.test(soc) ||
      !audio.includes("audio-muted")
    )
      throw new Error("native lacks required desktop/manager capabilities");
    return {
      revision,
      sourceSha256,
      sourceManifestSha256: await sha256(manifestPath),
      capabilities: { gdb, machine: required, uid: true, audioMuted: true },
      sourceManifest,
    };
  } catch (error) {
    throw new Error(`Cannot stage gwemu: ${error.message}`, { cause: error });
  }
}
