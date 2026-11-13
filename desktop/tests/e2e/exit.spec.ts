import { test, expect } from "@playwright/test";
import electronPath from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Playwright's Electron debugger changes shutdown behavior. Exercise ordinary
// application processes too: a listening FD transfer previously caused a real
// Chromium SIGTRAP, even when no native emulator had been started.
for (const model of [undefined, "zelda", "mario"]) {
  test(`ordinary ${model ?? "idle"} desktop exits cleanly and reopens repeatedly`, async () => {
    test.setTimeout(60000);
    const root = await mkdtemp(join(tmpdir(), "gnw-exit-regression-"));
    let child: ChildProcess | undefined;
    let stderr = "";
    const wait = async <T>(
      check: () => Promise<T> | T,
    ): Promise<NonNullable<T>> => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const value = await check();
        if (value !== undefined && value !== false && value !== null)
          return value as NonNullable<T>;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error(`Application lifecycle deadline exceeded: ${stderr}`);
    };
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        child = spawn(
          electronPath as unknown as string,
          [
            resolve("."),
            "-ApplePersistenceIgnoreState",
            "YES",
            "--automation",
            `--user-data-dir=${root}`,
            ...(model ? [resolve(`../profiles/${model}.gnw.json`)] : []),
          ],
          {
            stdio: ["ignore", "ignore", "pipe"],
            env: { ...process.env, NODE_OPTIONS: "" },
          },
        );
        const cycleProcess = child;
        child.stderr!.on("data", (chunk) => {
          stderr += chunk;
        });
        const exited = new Promise<{
          code: number | null;
          signal: string | null;
        }>((r, j) => {
          child!.once("error", j);
          child!.once("exit", (code, signal) => r({ code, signal }));
        });
        const endpoint = await wait(async () => {
          if (child!.exitCode !== null || child!.signalCode !== null)
            throw Error(`Premature exit: ${stderr}`);
          return readFile(join(root, "automation.json"), "utf8").then(
            (json) => JSON.parse(json) as { url: string; token: string },
            () => undefined,
          );
        });
        const rpc = async (method: string, params: object = {}) => {
          const response = await fetch(endpoint.url, {
            method: "POST",
            headers: { authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(5000),
          });
          const reply = await response.json();
          if (reply.error) throw Error(JSON.stringify(reply.error));
          return reply.result;
        };
        await wait(
          async () =>
            (await rpc("app.getState")).status === (model ? "running" : "idle"),
        );
        const nativePid = (await rpc("app.getDiagnostics")).qemuPid;
        if (model) {
          await rpc("ui.waitFor", {
            condition: "ui.lastPresented",
            value: "2",
            timeoutMs: 15000,
          });
          if (cycle)
            expect((await rpc("ui.inspect")).window.preferredClockMode).toBe(
              true,
            );
          else {
            const operation = await rpc("ui.menu", { id: "view.clock" });
            const done = await wait(async () => {
              const state = await rpc("automation.getOperation", {
                operationId: operation.operationId,
              });
              return state.status === "pending" ? undefined : state;
            });
            expect(done.status, JSON.stringify(done)).toBe("succeeded");
          }
        } else expect(nativePid).toBeUndefined();
        await rpc("ui.menu", { id: "app.quit" });
        const result = await Promise.race([
          exited,
          wait(
            () =>
              cycleProcess.exitCode !== null ||
              cycleProcess.signalCode !== null,
          ).then(() => exited),
        ]);
        expect(result, stderr).toEqual({ code: 0, signal: null });
        expect(
          await readFile(join(root, "automation.json")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        if (nativePid) expect(() => process.kill(nativePid, 0)).toThrow();
        if (model)
          expect(
            JSON.parse(await readFile(join(root, "settings.json"), "utf8"))
              .clockMode,
          ).toBe(true);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise((r) => child!.once("exit", r));
        child.kill("SIGKILL");
        await stopped;
      }
      if (stderr)
        await test.info().attach("ordinary-electron-stderr", {
          body: stderr,
          contentType: "text/plain",
        });
      await rm(root, { recursive: true, force: true });
    }
  });
}
