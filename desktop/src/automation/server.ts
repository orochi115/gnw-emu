import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { writeJson } from "../core/atomic-file";
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
import {
  METHODS,
  validateAutomationParams,
} from "../shared/automation-contracts";
export { METHODS };
const actions = new Set([
  "ui.menu",
  "ui.click",
  "ui.fill",
  "ui.select",
  "ui.key",
  "ui.pointer",
]);
export async function startAutomationServer(options: {
  directory: string;
  instanceId: string;
  dispatch: (method: string, params: any) => Promise<unknown>;
}) {
  const token = randomBytes(32).toString("hex");
  const operations = new Map<string, any>();
  const server = createServer(async (req, res) => {
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      respond(401, { error: "Unauthorized" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      respond(404, { error: "Not found" });
      return;
    }
    let id: unknown = null;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) throw new RpcError(-32600, "Request too large");
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString());
      id = request.id;
      if (
        request.jsonrpc !== "2.0" ||
        !(typeof id === "string" || typeof id === "number") ||
        typeof request.method !== "string" ||
        (request.params !== undefined &&
          (typeof request.params !== "object" ||
            request.params === null ||
            Array.isArray(request.params)))
      )
        throw new RpcError(-32600, "Invalid request");
      const { method } = request;
      if (!METHODS.includes(method))
        throw new RpcError(-32601, "Unknown method");
      const params = validateAutomationParams(method, request.params ?? {});
      let result: unknown;
      if (method === "automation.capabilities")
        result = { instanceId: options.instanceId, methods: METHODS };
      else if (method === "automation.getOperation") {
        result = operations.get(params.operationId);
        if (!result) throw new RpcError(-32004, "Unknown operation");
      } else if (actions.has(method)) {
        if ([...operations.values()].some((o) => o.status === "pending"))
          throw new RpcError(-32001, "busy: another UI operation is pending");
        const operationId = randomUUID();
        const operation = {
          operationId,
          method,
          status: "pending",
          startedAt: Date.now(),
        } as any;
        operations.set(operationId, operation);
        if (operations.size > 200)
          operations.delete(operations.keys().next().value!);
        setImmediate(async () => {
          try {
            operation.result = await options.dispatch(method, {
              ...params,
              operationId,
            });
            operation.status = "succeeded";
          } catch (error) {
            operation.status = "failed";
            operation.error = {
              code: error instanceof RpcError ? error.code : -32000,
              message: (error as Error).message,
            };
          } finally {
            operation.finishedAt = Date.now();
          }
        });
        result = { operationId, status: "pending" };
      } else result = await options.dispatch(method, params);
      respond(200, { jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      respond(200, {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof RpcError ? error.code : -32602,
          message: (error as Error).message,
        },
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", r);
  });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/rpc`;
  const file = join(options.directory, "automation.json");
  await writeJson(file, {
    formatVersion: 1,
    instanceId: options.instanceId,
    pid: process.pid,
    url,
    token,
  });
  return {
    url,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(file, { force: true });
    },
  };
}
