import { test, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startAutomationServer } from "../../src/automation/server";
test("RPC rejects missing token, records operation results, and removes endpoint on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-rpc-"));
  const server = await startAutomationServer({
    directory: root,
    instanceId: "test",
    dispatch: async (method, params) => ({ method, params }),
  });
  try {
    const endpoint = JSON.parse(
      await readFile(join(root, "automation.json"), "utf8"),
    );
    const unauthorized = await fetch(endpoint.url, {
      method: "POST",
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
    const call = async (method: string, params: any = {}) =>
      (
        await fetch(endpoint.url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json() as Promise<any>;
    const action = await call("ui.click", { id: "rom.save" });
    expect(action.result.operationId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    const result = await call("automation.getOperation", {
      operationId: action.result.operationId,
    });
    expect(result.result.status).toBe("succeeded");
    expect((await call("app.getState")).result.method).toBe("app.getState");
  } finally {
    await server.close();
    await expect(readFile(join(root, "automation.json"))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  }
});
