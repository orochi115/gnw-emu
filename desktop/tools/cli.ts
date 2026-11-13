import { userMessage } from "../src/shared/locale";
import { resolve, join } from "node:path";
import {
  createProfile,
  loadProfile,
  ensureProfile,
} from "../src/core/profile-store";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeJson } from "../src/core/atomic-file";
import { SessionController } from "../src/core/session-controller";
import { createDisplayReceiver } from "../src/display/receiver";
import { createLogManager } from "../src/observability/logger";

const [command, file, ...args] = process.argv.slice(2);
try {
  if (command === "create") {
    const fields = JSON.parse(args.join(" "));
    const profile = await createProfile(resolve(file), fields);
    process.stdout.write(JSON.stringify(profile) + "\n");
  } else if (command === "ensure") {
    const model = args.shift();
    const fresh = args.includes("--fresh");
    const fields = Object.fromEntries(
      args
        .filter((v) => v !== "--fresh")
        .map((v) => {
          const i = v.indexOf("=");
          if (i < 1) throw new Error("Expected field=value");
          return [v.slice(0, i), v.slice(i + 1)];
        }),
    );
    const profile = await ensureProfile(
      resolve(file),
      { ...fields, model } as any,
      fresh,
    );
    process.stdout.write(JSON.stringify(profile) + "\n");
  } else if (command === "session-dir") {
    const profile = await loadProfile(resolve(file));
    process.stdout.write(
      join(
        process.env.GNW_USER_DATA ??
          resolve(import.meta.dirname, "../../UserData"),
        "kernels",
        "gwemu",
        "sessions",
        profile.id,
      ) + "\n",
    );
  } else if (command === "paths") {
    const profile = await loadProfile(resolve(file));
    process.stdout.write(JSON.stringify(profile) + "\n");
  } else if (command === "probe") {
    const seconds = Number(args[0] ?? 4);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
      throw new Error("Probe seconds must be 1..3600");
    const output = resolve(args[1] ?? "/tmp/gnw-probe");
    await mkdir(output, { recursive: true });
    const isolated = await mkdtemp(join(tmpdir(), "gnw-probe-"));
    await writeJson(join(isolated, "settings.json"), {
      formatVersion: 1,
      audio: false,
      realtime: true,
    });
    const controller = new SessionController({
      userData: isolated,
      qemu: resolve(import.meta.dirname, "../../build/gwemu/qemu-system-arm"),
      logger: createLogManager({ appInstanceId: "probe" }).child("probe"),
      createDisplay: () => createDisplayReceiver(() => {}),
    });
    try {
      await controller.load(resolve(file));
      await new Promise((r) => setTimeout(r, seconds * 1000));
      process.stdout.write(
        JSON.stringify(await controller.probe(join(output, "shot.png"))) + "\n",
      );
    } finally {
      await controller.stop();
      await rm(isolated, { recursive: true, force: true });
    }
  } else if (command === "launch") {
    const desktop = resolve(import.meta.dirname, "..");
    const binary =
      process.platform === "darwin"
        ? join(
            desktop,
            "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
          )
        : join(
            desktop,
            "node_modules/electron/dist",
            process.platform === "win32" ? "electron.exe" : "electron",
          );
    const child = spawn(
      binary,
      [
        desktop,
        ...(file ? [file.startsWith("--") ? file : resolve(file)] : []),
        ...args,
      ],
      { stdio: "inherit" },
    );
    child.on("error", (e) => {
      process.stderr.write(e.message + "\n");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  } else
    throw new Error(
      "Usage: cli.js create FILE.gnw.json JSON | session-dir FILE | paths FILE | launch [FILE]",
    );
} catch (error) {
  process.stderr.write(userMessage(error) + "\n");
  process.exitCode = 1;
}
