import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
for (const script of [
  "run_stock_emu.sh",
  "run_backup_emu.sh",
  "run_sd_emu.sh",
  "run_sd_update_emu.sh",
]) {
  test(`${script} starts real Electron/QEMU and quit saves its isolated session`, async () => {
    test.skip(
      process.env.GNW_LAUNCH_TEST !== "1",
      "Explicit workspace firmware launch smoke test",
    );
    test.setTimeout(90000);
    const root = await mkdtemp(join(tmpdir(), "gnw-launch-"));
    const child = spawn(
      resolve("../..", script),
      ["--automation", "--language=en", `--user-data-dir=${root}`],
      { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-16384);
      });
    const exited = new Promise<number | null>((r, j) => {
      child.once("exit", r);
      child.once("error", j);
    });
    let endpoint: any;
    let qemuPid: number | undefined;
    const rpc = async (method: string, params: any = {}) => {
      const result = (await (
        await fetch(endpoint.url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(5000),
        })
      ).json()) as any;
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    };
    try {
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
          { timeout: 30000, message: output },
        )
        .toBe(true);
      await expect
        .poll(async () => (await rpc("app.getState")).status, {
          timeout: 30000,
        })
        .toBe("running");
      const diagnostics = await rpc("app.getDiagnostics");
      qemuPid = diagnostics.qemuPid;
      expect(diagnostics.width).toBe(640);
      await expect
        .poll(
          async () =>
            Number((await rpc("ui.inspect")).canvas.lastPresented ?? 0),
          { timeout: 15000 },
        )
        .toBeGreaterThan(2);
      await mkdir(resolve("../out/ui-validation"), { recursive: true });
      await rpc("ui.screenshot", {
        path: resolve("../out/ui-validation", script.replace(".sh", ".png")),
      });
      await rpc("ui.menu", { id: "app.quit" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            exited,
            new Promise((_, j) => {
              timer = setTimeout(
                () => j(new Error("Launcher did not exit")),
                15000,
              );
            }),
          ]),
        ).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const sessions = await readdir(join(root, "kernels", "gwemu", "sessions"));
      expect(sessions).toHaveLength(1);
      const saved = JSON.parse(
        await readFile(
          join(root, "kernels", "gwemu", "sessions", sessions[0], "session.json"),
          "utf8",
        ),
      );
      expect(saved.formatVersion).toBe(1);
      expect(saved.battery).toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => {
          try {
            await readFile(join(root, "automation.json"));
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
    } catch (error) {
      throw new Error(`${script}: ${String(error)}\n${output}`);
    } finally {
      if (child.exitCode === null) {
        if (endpoint) await rpc("ui.menu", { id: "app.quit" }).catch(() => {});
        if (qemuPid) {
          try {
            process.kill(qemuPid, "SIGTERM");
          } catch {}
        }
        if (endpoint?.pid) {
          try {
            process.kill(endpoint.pid, "SIGTERM");
          } catch {}
        }
        child.kill();
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
