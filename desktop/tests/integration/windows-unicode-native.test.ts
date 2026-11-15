import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { SessionController } from "../../src/core/session-controller";
import { createLogManager } from "../../src/observability/logger";
import { createDisplayReceiver } from "../../src/display/receiver";
import { loadProfile } from "../../src/core/profile-store";
const enabled =
  process.platform === "win32" && process.env.GNW_WINDOWS_UNICODE === "1";
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
for (const unicode of [false, true])
  test.runIf(enabled)(
    `Windows native ${unicode ? "Chinese and emoji" : "ASCII"} paths support startup, snapshots and restart`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gnw-unicode-native-"));
      const directory = join(root, unicode ? "中文目录 游戏 🎮" : "ascii path");
      await mkdir(directory);
      const source = await loadProfile(
        resolve(
          process.env.GWEMU_WINDOWS_PROFILE ?? "../profiles/mario.gnw.json",
        ),
      );
      const hashes = await Promise.all([
        hash(source.internalFlash),
        hash(source.externalFlash),
      ]);
      const internal = unicode ? "内部镜像.bin" : "internal.bin";
      const external = unicode ? "外部镜像.bin" : "external.bin";
      await copyFile(source.internalFlash, join(directory, internal));
      await copyFile(source.externalFlash, join(directory, external));
      const profilePath = join(
        directory,
        unicode ? "马里奥配置.gnw.json" : "mario.gnw.json",
      );
      const { path: _path, ...fields } = source;
      await writeFile(
        profilePath,
        JSON.stringify({
          ...fields,
          internalFlash: internal,
          externalFlash: external,
        }),
      );
      const logs: string[] = [];
      const controller = new SessionController({
        kernel: "gwemu",
        qemu: resolve(
          process.env.GWEMU_BINARY ?? "../build/gwemu/qemu-system-arm.exe",
        ),
        userData: join(directory, unicode ? "用户数据" : "data"),
        managerDirectory: join(directory, unicode ? "会话通信" : "private"),
        timeout: 20000,
        logger: createLogManager({
          appInstanceId: "windows-unicode-native",
          destination: new Writable({
            write(c, _e, done) {
              logs.push(String(c));
              done();
            },
          }),
        }).child("session"),
        createDisplay: () => createDisplayReceiver(() => {}),
      });
      try {
        await controller.load(profilePath);
        expect(controller.state.status).toBe("running");
        await controller.instantState("save");
        expect(controller.state.stateSlots?.[0]).toBeTruthy();
        await controller.instantState("load");
        expect(controller.state.status).toBe("running");
        await controller.stop();
        await controller.load(profilePath);
        expect(controller.state.status).toBe("running");
        expect(controller.state.stateSlots?.[0]).toBeTruthy();
        await controller.instantState("load");
      } catch (error) {
        console.error(JSON.stringify({ root, state: controller.state, logs }));
        throw error;
      } finally {
        await controller.stop();
        expect(
          await Promise.all([
            hash(source.internalFlash),
            hash(source.externalFlash),
          ]),
        ).toEqual(hashes);
        expect(
          await Promise.all([
            hash(join(directory, internal)),
            hash(join(directory, external)),
          ]),
        ).toEqual(hashes);
      }
    },
    120000,
  );

test.runIf(enabled)(
  "Windows native raw disk opens and reports Chinese/emoji filenames",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gnw-unicode-disk-"));
    const image = join(root, "中文磁盘 🎮.img");
    await writeFile(image, Buffer.alloc(4096, 0x5a));
    const before = await hash(image);
    const child = spawn(
      resolve(process.env.GWEMU_BINARY ?? "../build/gwemu/qemu-system-arm.exe"),
      [
        "-M",
        "none",
        "-display",
        "none",
        "-S",
        "-qmp",
        "stdio",
        "-blockdev",
        `driver=file,node-name=unicode,filename=${image}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "",
      stdout = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.on("data", (c) => (stdout += c));
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
      const exit = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        '{"execute":"qmp_capabilities"}\n{"execute":"query-named-block-nodes"}\n{"execute":"quit"}\n',
      );
      expect(await exit, stderr).toBe(0);
      const replies = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(JSON.stringify(replies)).toContain("中文磁盘");
      expect(await hash(image)).toBe(before);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
  },
  30000,
);
