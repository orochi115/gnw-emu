import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProfile } from "../../src/core/profile-store";
import type { ProfileFields } from "../../src/core/schemas";
import { closeOwnedApplication, processHooks } from "./helpers/owned-processes";

const project = resolve("..");
const python = join(project, "build/gnwmanager-python/bin/python");
const native = join(
  project,
  "build/gwemu-session-manager-release/qemu-system-arm",
);
const elf = join(project, "build/gnwmanager-ram-release/gnwmanager.elf");
const gdb = "/opt/gcc-arm-none-eabi-10.3-2021.10/bin/arm-none-eabi-gdb";
const evidenceRoot = join(project, "out/gwemu-completion/manager-workflow");
const discovery = `/tmp/gnw-manager-${process.getuid!()}`;
const mario: ProfileFields = {
  model: "mario",
  internalFlash: resolve("../../firmware/internal_flash_backup_mario.bin"),
  externalFlash: resolve("../../firmware/flash_backup_mario.bin"),
  deviceUid: "310047000b51333138343134",
};
const digest = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let protectedSources: Record<string, { bytes: number; sha256: string }>;
let foreign: Record<string, string>;

test.beforeAll(async () => {
  for (const path of [python, native, elf, gdb])
    expect(existsSync(path), path).toBe(true);
  const manifest = JSON.parse(
    await readFile(
      join(
        project,
        "build/gwemu-session-manager-release/gnw-build-manifest.json",
      ),
      "utf8",
    ),
  );
  expect(manifest.sourceDirty).toBe(false);
  expect(manifest.revision).toBe("a38484468d947ce6447fcc7dec47ebeef041f853");
  expect(await digest(native)).toBe(
    "a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e",
  );
  expect(
    await digest(join(project, "externals/gnwmanager/gnwmanager/firmware.bin")),
  ).toBe("bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9");
  protectedSources = JSON.parse(
    await readFile(
      join(project, "out/gwemu-completion/backup-source-audit.json"),
      "utf8",
    ),
  ).sources;
  for (const [path, expected] of Object.entries(protectedSources))
    expect(await digest(path), path).toBe(expected.sha256);
  foreign = {};
  for (const name of await readdir(discovery).catch(() => []))
    if (name.endsWith(".json"))
      foreign[name] = await digest(join(discovery, name));
  await mkdir(evidenceRoot, { recursive: true });
});
test.afterAll(async () => {
  for (const [path, expected] of Object.entries(protectedSources))
    expect(await digest(path), path).toBe(expected.sha256);
  for (const [name, hash] of Object.entries(foreign))
    expect(await digest(join(discovery, name))).toBe(hash);
  await writeFile(
    join(evidenceRoot, "protected-sources.json"),
    JSON.stringify(
      { sources: protectedSources, foreignDescriptors: foreign },
      null,
      2,
    ),
  );
});

type Command = {
  args: string[];
  pid: number;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};
class Desktop {
  app!: ElectronApplication;
  appChild!: ChildProcess;
  root!: string;
  endpoint!: { url: string; token: string };
  session!: string;
  nativePids = new Set<number>();
  clients = new Set<ChildProcess>();
  commands: Command[] = [];
  evidence: Record<string, any> = {};
  ownedEndpoints: string[] = [];
  constructor(readonly name: string) {}
  async open(fields?: ProfileFields) {
    this.root = await mkdtemp(join(tmpdir(), "gnw-manager-e2e-"));
    const profile = fields
      ? await createProfile(join(this.root, "guest.gnw.json"), fields)
      : undefined;
    this.app = await electron.launch({
      args: [
        resolve("."),
        "--language=zh-CN",
        "--automation",
        "--test-dialogs",
        `--user-data-dir=${this.root}`,
        ...(profile ? [profile.path] : []),
      ],
      env: { ...process.env, GNW_KERNEL: "gwemu" },
    });
    this.appChild = this.app.process();
    await this.app.firstWindow();
    await expect
      .poll(
        async () => {
          try {
            this.endpoint = JSON.parse(
              await readFile(join(this.root, "automation.json"), "utf8"),
            );
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 15000 },
      )
      .toBe(true);
    if (profile) {
      await this.rpc("ui.waitFor", {
        condition: "app.status",
        value: "running",
        timeoutMs: 15000,
      });
      await expect
        .poll(() =>
          this.app.evaluate(
            ({ Menu }) =>
              Menu.getApplicationMenu()!.getMenuItemById("file.open")!.enabled,
          ),
        )
        .toBe(true);
      this.session = (await this.rpc("app.getState")).runtimeSessionId;
      const pid = (await this.rpc("app.getDiagnostics")).qemuPid;
      expect(pid).toBeGreaterThan(0);
      this.nativePids.add(pid);
      this.evidence.session = this.session;
      this.evidence.profile = profile;
    }
    this.evidence.appPid = this.appChild.pid;
    this.evidence.discoveryDirectory = discovery;
    for (const name of await readdir(discovery)) {
      if (!name.endsWith(".json")) continue;
      const descriptor = JSON.parse(
        await readFile(join(discovery, name), "utf8"),
      );
      if (descriptor.pid === this.app.process().pid)
        this.ownedEndpoints.push(join(discovery, name), descriptor.endpoint);
    }
    for (const pid of this.nativePids) {
      const args = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
      const socket = args.match(/-gdb unix:([^, ]+)/)?.[1];
      if (socket) this.ownedEndpoints.push(socket);
    }
  }
  async rpc(method: string, params: any = {}) {
    const body: any = await (
      await fetch(this.endpoint.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.endpoint.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(25000),
      })
    ).json();
    if (body.error) throw Error(JSON.stringify(body.error));
    return body.result;
  }
  async action(method: string, params: any) {
    const result = await this.rpc(method, params);
    let operation: any;
    await expect
      .poll(
        async () => {
          operation = await this.rpc("automation.getOperation", {
            operationId: result.operationId,
          });
          return operation.status;
        },
        { timeout: 20000 },
      )
      .not.toBe("pending");
    expect(operation.error, JSON.stringify(operation)).toBeUndefined();
    return operation.result;
  }
  start(args: string[], input = "", timeoutMs = 120000) {
    const child = spawn(
      python,
      ["-m", "gnwmanager", "--session", this.session, ...args],
      {
        cwd: project,
        env: { ...process.env, GDB: gdb, PYTHONUNBUFFERED: "1" },
        stdio: "pipe",
      },
    );
    this.clients.add(child);
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr!.on("data", (b) => {
      stderr += b.toString();
    });
    child.stdin!.end(input);
    const done = new Promise<Command>((accept, reject) => {
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      const hard = setTimeout(() => {
        for (const pid of processHooks.descendants(child.pid!))
          if (pid !== 16603 && processHooks.alive(pid))
            process.kill(pid, "SIGKILL");
      }, timeoutMs + 3000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        clearTimeout(hard);
        this.clients.delete(child);
        const result = { args, pid: child.pid!, code, signal, stdout, stderr };
        this.commands.push(result);
        accept(result);
      });
    });
    return { child, done, stdout: () => stdout };
  }
  async cli(args: string[], input = "", timeoutMs = 120000) {
    const result = await this.start(args, input, timeoutMs).done;
    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.signal).toBeNull();
    return result.stdout;
  }
  async returned(execution: string) {
    await expect
      .poll(
        async () => {
          const state = await this.rpc("app.getState");
          return [state.execution, !!state.deviceOperation];
        },
        { timeout: 15000 },
      )
      .toEqual([execution, false]);
    expect((await this.rpc("app.getDiagnostics")).input.appliedMask).toBe(0);
  }
  async forceQuitUncertain() {
    // This is an explicit Force Quit of a failed session, never a successful save.
    const state = await this.rpc("app.getState");
    expect(state.execution === "unknown" || state.status === "error").toBe(
      true,
    );
    this.evidence.failedSessionState = state;
    expect(state.saveUncertain).toBe(true);
    await this.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() => [...this.nativePids].filter(processHooks.alive), {
        timeout: 10000,
      })
      .toEqual([]);
    await expect
      .poll(() => this.ownedEndpoints.filter(existsSync), { timeout: 10000 })
      .toEqual([]);
    await delay(500);
    if (!processHooks.alive(this.appChild.pid!)) {
      this.evidence.shutdown =
        "production UI close retired endpoints and exited after the already-reported failed native save";
      return;
    }
    expect((await this.rpc("app.getState")).saveUncertain).toBe(true);
    this.evidence.shutdown =
      "production UI close stopped native and retired endpoints; failed save warning; explicit force quit";
    this.appChild.kill("SIGKILL");
    await expect
      .poll(() => processHooks.alive(this.appChild.pid!), { timeout: 5000 })
      .toBe(false);
  }
  async close() {
    for (const child of this.clients) child.kill("SIGTERM");
    await expect.poll(() => this.clients.size, { timeout: 6000 }).toBe(0);
    try {
      if (this.app)
        await closeOwnedApplication(
          {
            pid: this.appChild.pid!,
            nativePids: this.nativePids,
            close: () =>
              processHooks.alive(this.appChild.pid!)
                ? this.app.close()
                : Promise.resolve(),
          },
          this.evidence,
        );
      await expect
        .poll(() => this.ownedEndpoints.filter(existsSync), { timeout: 5000 })
        .toEqual([]);
    } finally {
      this.evidence.commands = this.commands;
      this.evidence.remainingClientPids = this.commands
        .map((c) => c.pid)
        .filter(processHooks.alive);
      expect(this.evidence.remainingClientPids).toEqual([]);
      this.evidence.ownedEndpoints = this.ownedEndpoints;
      this.evidence.remainingEndpoints = this.ownedEndpoints.filter(existsSync);
      this.evidence.binarySha256 = await digest(native);
      this.evidence.firmwareSha256 = await digest(
        join(project, "externals/gnwmanager/gnwmanager/firmware.bin"),
      );
      await writeFile(
        join(evidenceRoot, `${this.name}.json`),
        JSON.stringify(this.evidence, null, 2),
      );
      await rm(this.root, { recursive: true, force: true });
    }
  }
}

test("manager storage through the actual selected desktop ROM", async () => {
  test.setTimeout(300000);
  const host = new Desktop("storage");
  try {
    await host.open(mario);
    expect(await host.cli(["sessions"])).toContain(host.session);
    expect(await host.cli(["info"])).toContain("External Flash Size (MB):");
    await host.returned("running");
    // Desktop images initially have RDP0. Exercise the stock RDP1 unlock path.
    expect(
      await host.cli(["lock", "--skip-check", "--no-interactive"]),
    ).toContain("cold-start protection verified");
    const unlock = join(host.root, "unlock");
    expect(
      await host.cli(["unlock", "--model", "mario", "--backup-dir", unlock]),
    ).toContain("Unlocking complete!");
    expect(await digest(join(unlock, "internal_flash_backup_mario.bin"))).toBe(
      await digest(mario.internalFlash),
    );
    expect(await digest(join(unlock, "flash_backup_mario.bin"))).toBe(
      await digest(mario.externalFlash),
    );
    const backup = join(host.root, "archive"),
      fetched = join(host.root, "fetched");
    expect(await host.cli(["backup", "--out", backup])).toContain(
      "Backup verified (complete)",
    );
    expect(await host.cli(["verify-backup", backup])).toContain(
      "Backup verified:",
    );
    const server = createServer(async (request, response) => {
      try {
        const path = join(
          backup,
          new URL(request.url!, "http://localhost").pathname.replace(
            /^\/archive\//,
            "",
          ),
        );
        const data = await readFile(path);
        response.writeHead(200);
        response.end(data);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      expect(
        await host.cli([
          "fetch-backup",
          `http://127.0.0.1:${port}/archive`,
          "--dest",
          fetched,
        ]),
      ).toContain("Fetched and verified:");
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
    expect(
      await host.cli([
        "restore-backup",
        fetched,
        "--only",
        "bank1,ext",
        "--yes",
      ]),
    ).toContain("Restore verified: bank1, ext");
    const payload = join(host.root, "payload.bin"),
      readback = join(host.root, "readback.bin");
    const data = Buffer.from(
      Array.from({ length: 8192 }, (_, i) => (i * 37 + 19) & 255),
    );
    await writeFile(payload, data);
    await host.cli([
      "flash",
      "ext",
      payload,
      "--offset",
      "0xf0000",
      "--",
      "dump",
      "ext",
      readback,
      "--size",
      String(data.length),
      "--offset",
      "0xf0000",
    ]);
    expect(await readFile(readback)).toEqual(data);
    const pulled = join(host.root, "pulled.bin");
    const list = await host.cli([
      "format",
      "--size",
      "131072",
      "--",
      "mkdir",
      "/task6",
      "--",
      "push",
      "/task6/payload.bin",
      payload,
      "--",
      "pull",
      "/task6/payload.bin",
      pulled,
      "--",
      "ls",
      "/task6",
      "--",
      "rm",
      "/task6/payload.bin",
      "--",
      "ls",
      "/task6",
    ]);
    expect(await readFile(pulled)).toEqual(data);
    expect(list.match(/payload.bin/g)).toHaveLength(1);
    const png = join(evidenceRoot, "manager-framebuffer.png");
    await host.cli([
      "screenshot",
      "capture",
      png,
      "--elf",
      elf,
      "--framebuffer",
      "framebuffer",
    ]);
    const bytes = await readFile(png);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
      320, 240,
    ]);
    expect(
      await host.app.evaluate(({ nativeImage }, path) => {
        const decoded = nativeImage.createFromPath(path);
        return {
          empty: decoded.isEmpty(),
          size: decoded.getSize(),
          bytes: decoded.toBitmap().length,
        };
      }, png),
    ).toEqual({
      empty: false,
      size: { width: 320, height: 240 },
      bytes: 320 * 240 * 4,
    });
    await host.cli(["restore-backup", backup, "--only", "ext", "--yes"]);
    expect(
      await host.cli(["lock", "--skip-check", "--no-interactive"]),
    ).toContain("cold-start protection verified");
    expect(await host.cli(["info"])).toContain("LOCKED");
    await host.returned("running");
  } finally {
    await host.close();
  }
});

async function synthetic(root: string) {
  await mkdir(root, { recursive: true });
  const text = "actual guest log through public manager RSP\n";
  const source = join(root, "guest.S"),
    symbols = join(root, "guest.elf"),
    image = join(root, "guest.bin");
  await writeFile(
    source,
    `.syntax unified\n.cpu cortex-m7\n.thumb\n.section .text\n.global vectors\nvectors:\n.word 0x20020000\n.word reset\n.thumb_func\n.global reset\nreset:\nnop\n.global guest_loop\nguest_loop:\nnop\nb guest_loop\n.balign 4\n.global logbuf\n.type logbuf,%object\nlogbuf:\n.asciz ${JSON.stringify(text)}\n.size logbuf, .-logbuf\n.balign 4\n.global log_idx\n.type log_idx,%object\nlog_idx:\n.word ${Buffer.byteLength(text)}\n.size log_idx,4\n`,
  );
  const compiler = gdb.replace(/gdb$/, "gcc"),
    objcopy = gdb.replace(/gdb$/, "objcopy");
  execFileSync(
    compiler,
    [
      "-mcpu=cortex-m7",
      "-mthumb",
      "-nostdlib",
      "-Wl,-Ttext=0x08000000",
      "-Wl,-e,reset",
      source,
      "-o",
      symbols,
    ],
    { timeout: 10000 },
  );
  execFileSync(objcopy, ["-O", "binary", symbols, image], { timeout: 10000 });
  return { fields: { ...mario, internalFlash: image }, symbols, text };
}

test("manager real GDB reads writes steps and hits a breakpoint", async () => {
  test.setTimeout(60000);
  const sourceRoot = await mkdtemp(join(tmpdir(), "gnw-manager-guest-"));
  const host = new Desktop("debugger");
  try {
    const guest = await synthetic(sourceRoot);
    await host.open(guest.fields);
    const output = await host.cli(
      ["gdb", guest.symbols],
      [
        "set confirm off",
        "set {int}0x20000100 = 0x12345678",
        "x/wx 0x20000100",
        "set $r0 = 0x33445566",
        "p/x $r0",
        "set $pc = 0x08000008",
        "stepi",
        "break *guest_loop",
        "continue",
        "info break",
        "quit",
        "",
      ].join("\n"),
    );
    expect(output).toContain("0x12345678");
    expect(output).toContain("0x33445566");
    expect(output).toMatch(/Breakpoint 1,.*guest_loop/);
    await host.returned("running");
  } finally {
    await host.close();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("manager monitor reads the real guest log and cleans interrupted ownership", async () => {
  test.setTimeout(60000);
  const sourceRoot = await mkdtemp(join(tmpdir(), "gnw-manager-guest-"));
  const host = new Desktop("monitor");
  try {
    const guest = await synthetic(sourceRoot);
    await host.open(guest.fields);
    const monitor = host.start([
      "monitor",
      "--elf",
      guest.symbols,
      "--buffer",
      "logbuf",
      "--index",
      "log_idx",
    ]);
    await expect.poll(monitor.stdout, { timeout: 10000 }).toContain(guest.text);
    monitor.child.kill("SIGINT");
    const result = await monitor.done;
    expect(result.code).not.toBe(0);
    await host.returned("unknown");
    await host.forceQuitUncertain();
  } finally {
    await host.close();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

for (const interruption of ["client", "native", "ui-close"]) {
  test(`manager ${interruption} interruption revokes ownership and isolates ROM identity`, async () => {
    test.setTimeout(90000);
    const host = new Desktop(`interruption-${interruption}`);
    try {
      await host.open(mario);
      const original = host.session;
      const held = host.start(["gdbserver"]);
      await expect
        .poll(held.stdout, { timeout: 10000 })
        .toContain("target remote ");
      const proxy = held.stdout().match(/target remote (\/[^\s]+)/)![1];
      host.ownedEndpoints.push(proxy);
      expect((await host.rpc("app.getState")).deviceOperation).toBe(true);
      const menus = await host.app.evaluate(({ Menu }) =>
        Object.fromEntries(
          ["file.open", "state.save", "state.load"].map((id) => [
            id,
            Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled,
          ]),
        ),
      );
      expect(menus).toEqual({
        "file.open": false,
        "state.save": false,
        "state.load": false,
      });
      await expect(
        host.action("ui.menu", { id: "file.open" }),
      ).rejects.toThrow();
      for (const key of ["Left", "F5", "F8"]) {
        await host.action("ui.key", { key, down: true });
        await host.action("ui.key", { key, down: false });
      }
      expect((await host.rpc("app.getDiagnostics")).input.appliedMask).toBe(0);
      expect((await host.rpc("app.getState")).runtimeSessionId).toBe(original);
      const slot = join(
        host.root,
        "kernels/gwemu/sessions",
        host.evidence.profile.id,
        "states-gwemu",
      );
      expect(existsSync(slot)).toBe(false);
      host.evidence.blockedMenus = menus;
      if (interruption === "client") {
        held.child.kill("SIGTERM");
        expect((await held.done).code).toBe(143);
        await host.returned("unknown");
        // First reopen reports the failed prior save; the explicit retry starts a new ROM.
        const next = await createProfile(
          join(host.root, "next.gnw.json"),
          mario,
        );
        await host.rpc("automation.queueDialogResponse", {
          kind: "open",
          path: next.path,
        });
        await expect(
          host.action("ui.menu", { id: "file.open" }),
        ).rejects.toThrow();
        expect((await host.rpc("app.getState")).saveUncertain).toBe(true);
        await host.rpc("automation.queueDialogResponse", {
          kind: "open",
          path: next.path,
        });
        await host.action("ui.menu", { id: "file.open" });
        await host.rpc("ui.waitFor", {
          condition: "app.status",
          value: "running",
          timeoutMs: 15000,
        });
        const current = (await host.rpc("app.getState")).runtimeSessionId;
        expect(current).not.toBe(original);
        host.nativePids.add((await host.rpc("app.getDiagnostics")).qemuPid);
        const nextPid = (await host.rpc("app.getDiagnostics")).qemuPid;
        const nextArgs = execFileSync(
          "ps",
          ["-p", String(nextPid), "-o", "command="],
          { encoding: "utf8" },
        );
        host.ownedEndpoints.push(nextArgs.match(/-gdb unix:([^, ]+)/)![1]);
        const stale = await host.start(["device-state"]).done;
        expect(stale.code).toBe(1);
        expect(stale.stdout).toContain("No unique matching desktop session");
        expect((await host.rpc("app.getState")).runtimeSessionId).toBe(current);
        expect((await host.rpc("app.getState")).execution).toBe("running");
        host.session = current;
        host.evidence.replacementSession = current;
        await host.cli(["device-state"]);
        await host.returned("running");
      } else if (interruption === "native") {
        process.kill([...host.nativePids][0], "SIGKILL");
        expect((await held.done).code).not.toBe(0);
        await expect
          .poll(async () => (await host.rpc("app.getState")).status)
          .toBe("error");
        await host.forceQuitUncertain();
      } else {
        // Real window-close runs production shutdown, revokes the manager and quits native.
        await host.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].close(),
        );
        expect((await held.done).code).not.toBe(0);
        await expect
          .poll(() => [...host.nativePids].filter(processHooks.alive), {
            timeout: 10000,
          })
          .toEqual([]);
        await expect
          .poll(() => host.ownedEndpoints.filter(existsSync), {
            timeout: 10000,
          })
          .toEqual([]);
        const state = await host.rpc("app.getState");
        expect(state.saveUncertain).toBe(true);
        host.evidence.shutdown =
          "UI close revoked manager and stopped native; save-uncertain warning remains; explicit force quit";
        host.evidence.failedSessionState = state;
        // The OS-native alert cannot be driven without macOS Accessibility permission.
        // Record the warning state, then simulate the user's explicit Force Quit.
        host.appChild.kill("SIGKILL");
        await expect
          .poll(() => processHooks.alive(host.appChild.pid!), { timeout: 5000 })
          .toBe(false);
      }
      expect(existsSync(proxy)).toBe(false);
    } finally {
      await host.close();
    }
  });
}

for (const wiring of ["spi1", "ospi"] as const) {
  test(`manager SD read write delete in desktop ${wiring}`, async () => {
    test.setTimeout(150000);
    const host = new Desktop(`sd-${wiring}`);
    try {
      await host.open({
        model: "zelda",
        internalFlash: join(project, "out/sd/full_20261104_1021_bank1.bin"),
        externalFlash: resolve(
          "../../game-and-watch-backup/backups/full_20261104_1021/ext.bin",
        ),
        bank2Flash: join(
          project,
          "externals/retro-go-sd/build/gw_retro_go_intflash.bin",
        ),
        sdCard: join(project, "out/sd/sdcard.img"),
        sdWiring: wiring,
      });
      const payload = join(host.root, "payload.bin"),
        readback = join(host.root, "readback.bin");
      const data = Buffer.from(
        `public manager Electron ${wiring}\n`.repeat(400),
      );
      await writeFile(payload, data);
      await host.cli([
        "sdpush",
        payload,
        "/TASK6.BIN",
        "--",
        "sdpull",
        "/TASK6.BIN",
        readback,
      ]);
      expect(await readFile(readback)).toEqual(data);
      expect(await host.cli(["sdls", "/"])).toContain("TASK6.BIN");
      expect(
        await host.cli(["sdrm", "/TASK6.BIN", "--", "sdls", "/"]),
      ).not.toContain("TASK6.BIN");
      await host.returned("running");
    } finally {
      await host.close();
    }
  });
}

for (const initial of ["running", "paused", "unpowered"]) {
  test(`manager returns to ${initial} application state`, async () => {
    test.setTimeout(60000);
    const host = new Desktop(`initial-${initial}`);
    try {
      await host.open(mario);
      if (initial === "paused")
        await host.action("ui.menu", { id: "device.pause" });
      if (initial === "unpowered") {
        await host.cli([
          "power",
          "usb-power",
          "false",
          "--",
          "power",
          "battery-present",
          "false",
        ]);
      }
      await host.returned(initial);
      expect(await host.cli(["device-state"])).toContain(host.session);
      if (initial !== "unpowered") await host.cli(["info"]);
      await host.returned(initial);
    } finally {
      await host.close();
    }
  });
}

test("manager machine power and POWER button workflow", async () => {
  test.setTimeout(90000);
  const host = new Desktop("power");
  try {
    await host.open(mario);
    await host.cli([
      "power",
      "usb-power",
      "true",
      "--",
      "power",
      "battery-present",
      "false",
    ]);
    expect((await host.rpc("app.getState")).devicePower).toMatchObject({
      usbPower: true,
      batteryPresent: false,
      powered: true,
    });
    await host.cli(["press", "0x200", "--duration-ms", "120"]);
    await host.cli(["power", "usb-power", "false"]);
    await host.returned("unpowered");
    await host.cli([
      "power",
      "battery",
      "70",
      "--",
      "power",
      "battery-present",
      "true",
      "--",
      "power",
      "cold-start",
      "--",
      "press",
      "0x200",
      "--duration-ms",
      "120",
      "--",
      "power",
      "usb-power",
      "true",
    ]);
    await host.returned("running");
    expect((await host.rpc("app.getState")).devicePower).toMatchObject({
      battery: 70,
      batteryPresent: true,
      usbPower: true,
      powered: true,
    });
    await host.cli(["power", "pause"]);
    await host.returned("paused");
    await host.cli(["power", "warm-reset"]);
    await host.returned("paused");
    await host.cli(["power", "resume"]);
    await host.returned("running");
  } finally {
    await host.close();
  }
});

test("desktop without a ROM does not start native", async () => {
  test.setTimeout(45000);
  const host = new Desktop("no-rom");
  try {
    await host.open();
    expect((await host.rpc("app.getState")).status).toBe("idle");
    expect((await host.rpc("app.getDiagnostics")).qemuPid).toBeUndefined();
    const children = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    expect(
      children
        .split("\n")
        .filter(
          (row) =>
            row.includes(native) &&
            row.trim().split(/\s+/)[1] === String(host.app.process().pid),
        ),
    ).toEqual([]);
  } finally {
    await host.close();
  }
});
