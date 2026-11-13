import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProfile } from "../../src/core/profile-store";
const run = promisify(execFile),
  project = resolve("..");
const python = join(project, "build/windows-python/Scripts/python.exe");
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
test.skip(process.platform !== "win32", "Windows native acceptance");
for (const model of ["mario", "zelda"] as const) {
  test(`Windows ${model}: LCD, input, states, manager and clean shutdown`, async ({}, testInfo) => {
    test.setTimeout(300000);
    const root = await mkdtemp(join(tmpdir(), "gnw-win-e2e-"));
    const evidence = resolve("../out/windows-acceptance");
    await mkdir(evidence, { recursive: true });
    const internal = join(project, `local/internal_flash_backup_${model}.bin`);
    const external = join(project, `local/flash_backup_${model}.bin`);
    const original = [await hash(internal), await hash(external)];
    const profile = await createProfile(join(root, "guest.gnw.json"), {
      model,
      internalFlash: internal,
      externalFlash: external,
      ...(model === "mario" ? { deviceUid: "310047000b51333138343134" } : {}),
    });
    const packaged = process.env.GNW_WINDOWS_PACKAGED;
    const app = await electron.launch({
      ...(packaged ? { executablePath: packaged } : {}),
      args: [
        ...(packaged ? [] : [resolve(".")]),
        "--language=en",
        "--automation",
        "--test-dialogs",
        `--user-data-dir=${root}`,
        profile.path,
      ],
      env: { ...process.env, GNW_KERNEL: "gwemu" },
    });
    let closed = false,
      endpoint: { url: string; token: string },
      diagnostics: any;
    try {
      const page = await app.firstWindow();
      await expect
        .poll(
          async () => {
            try {
              endpoint = JSON.parse(
                await readFile(join(root, "automation.json"), "utf8"),
              );
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        )
        .toBe(true);
      const rpc = async (method: string, params: any = {}) => {
        const value: any = await (
          await fetch(endpoint.url, {
            method: "POST",
            headers: { authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(30000),
          })
        ).json();
        if (value.error) throw Error(JSON.stringify(value.error));
        return value.result;
      };
      const action = async (method: string, params: any) => {
        const result = await rpc(method, params);
        let operation: any;
        await expect
          .poll(
            async () => {
              operation = await rpc("automation.getOperation", {
                operationId: result.operationId,
              });
              return operation.status;
            },
            { timeout: 30000 },
          )
          .not.toBe("pending");
        expect(operation.error, JSON.stringify(operation)).toBeUndefined();
      };
      const menu = (id: string) =>
        app.evaluate(
          ({ Menu }, item) =>
            Menu.getApplicationMenu()!.getMenuItemById(item)!.click(),
          id,
        );
      await rpc("ui.waitFor", {
        condition: "app.status",
        value: "running",
        timeoutMs: 30000,
      });
      await expect
        .poll(async () => Number((await rpc("app.getDiagnostics")).frames), {
          timeout: 30000,
        })
        .toBeGreaterThan(20);
      await expect
        .poll(
          () =>
            page.locator("canvas").evaluate((canvas: any) => {
              const data = canvas
                .getContext("2d")
                .getImageData(0, 0, canvas.width, canvas.height).data;
              let lit = 0;
              for (let i = 0; i < data.length; i += 4)
                if (data[i] + data[i + 1] + data[i + 2] > 30) lit++;
              return lit;
            }),
          { timeout: 30000 },
        )
        .toBeGreaterThan(20000);
      await rpc("ui.screenshot", {
        path: join(evidence, `${model}${packaged ? "-packaged" : ""}.png`),
      });
      await action("ui.key", { key: "Left", down: true });
      await expect
        .poll(async () => (await rpc("app.getDiagnostics")).input.appliedMask)
        .toBe(1);
      await action("ui.key", { key: "Left", down: false });
      await expect
        .poll(async () => (await rpc("app.getDiagnostics")).input.appliedMask)
        .toBe(0);
      expect((await rpc("app.getState")).canInstantState).toBe(true);
      await menu("state.slot.0");
      await menu("state.save");
      const slot = join(
        root,
        "kernels/gwemu/sessions",
        profile.id,
        "states-gwemu/slot-0.json",
      );
      await expect
        .poll(
          async () => {
            try {
              return JSON.parse(await readFile(slot, "utf8")).version;
            } catch {
              return 0;
            }
          },
          { timeout: 30000 },
        )
        .toBe(2);
      await expect
        .poll(async () => (await rpc("app.getState")).stateOperation)
        .toBeUndefined();
      await menu("device.pause");
      await expect
        .poll(async () => (await rpc("app.getState")).execution)
        .toBe("paused");
      await menu("state.load");
      await expect(
        page.getByRole("status").filter({ hasText: /Loaded slot 0/i }),
      ).toBeVisible({ timeout: 30000 });
      await expect
        .poll(async () => (await rpc("app.getState")).stateOperation)
        .toBeUndefined();
      expect((await rpc("app.getState")).execution).toBe("paused");
      await menu("device.resume");
      console.log(`${model}: LCD, input, save/load passed`);
      const session = (await rpc("app.getState")).runtimeSessionId,
        commands: any[] = [];
      for (const args of [
        ["sessions"],
        ["info"],
        ...(model === "mario"
          ? [
              ["backup", "--out", join(root, "backup")],
              ["verify-backup", join(root, "backup")],
            ]
          : []),
      ]) {
        const result = await run(
          python,
          ["-m", "gnwmanager", "--session", session, ...args],
          {
            cwd: project,
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
            timeout: 120000,
          },
        );
        commands.push({ args, ...result });
        console.log(`${model}: manager ${args[0]} finished`);
        await writeFile(
          join(evidence, `${model}-commands.json`),
          JSON.stringify(commands, null, 2),
        );
        if (args[0] === "sessions") expect(result.stdout).toContain(session);
        if (args[0] === "info")
          expect(result.stdout).toContain("External Flash Size (MB):");
        if (args[0] === "backup")
          expect(result.stdout).toContain("Backup verified (complete)");
        if (args[0] === "verify-backup")
          expect(result.stdout).toContain("Backup verified:");
        await expect
          .poll(async () => (await rpc("app.getState")).execution)
          .toBe("running");
      }
      diagnostics = await rpc("app.getDiagnostics");
      const pid = diagnostics.qemuPid;
      await app.close();
      closed = true;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      expect([await hash(internal), await hash(external)]).toEqual(original);
      await writeFile(
        join(evidence, `${model}${packaged ? "-packaged" : ""}.json`),
        JSON.stringify(
          {
            diagnostics,
            commands,
            sourceHashes: original,
            shutdown: "native exited",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await testInfo.attach("diagnostics", {
        body: JSON.stringify(diagnostics ?? {}, null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      if (!closed) {
        const pid = app.process().pid!;
        let timer: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            app.close(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("owned app close timed out")),
                10000,
              );
            }),
          ]);
        } catch {
          await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(
            () => {},
          );
        } finally {
          clearTimeout(timer!);
        }
      }
      expect([await hash(internal), await hash(external)]).toEqual(original);
      await rm(root, { recursive: true, force: true });
    }
  });
}
