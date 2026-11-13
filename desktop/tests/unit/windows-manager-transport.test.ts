import { describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import { listenAuthenticatedLoopback } from "../../src/core/windows-manager-transport";

describe("Windows private manager transport", () => {
  it("accepts only the full secret before delivering RPC bytes", async () => {
    const token = "a".repeat(64);
    const received: string[] = [];
    const server = await listenAuthenticatedLoopback(token, (socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk.toString());
        socket.end("ok");
      });
    });
    const port = (server.address() as { port: number }).port;
    const rejected = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => {
      rejected.on("close", resolve);
      rejected.write("b".repeat(64) + "forbidden\n");
    });
    expect(received).toEqual([]);
    const accepted = createConnection({ host: "127.0.0.1", port });
    const result = await new Promise<string>((resolve) => {
      accepted.on("data", (data) => resolve(data.toString()));
      accepted.write(token.slice(0, 32));
      setTimeout(() => accepted.write(token.slice(32) + "hello\n"), 10);
    });
    expect(result).toBe("ok");
    expect(received).toEqual(["hello\n"]);
    accepted.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
