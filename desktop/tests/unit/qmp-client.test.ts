import { test, expect } from "vitest";
import { createConnection } from "node:net";
import { createLogManager } from "../../src/observability/logger";
import { Writable } from "node:stream";
import { QmpClient } from "../../src/core/qmp-client";
test("QMP listener negotiates and correlates out-of-order replies", async () => {
  const logs = createLogManager({
    appInstanceId: "qmp-test",
    level: "debug",
    destination: new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
  });
  const client = new QmpClient(logs.child("qmp"));
  const port = await client.listen();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.write(
    JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + "\n",
  );
  let buffer = "";
  const requests: any[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.execute === "qmp_capabilities")
        socket.write(JSON.stringify({ return: {}, id: message.id }) + "\n");
      else {
        requests.push(message);
        if (requests.length === 2)
          for (const r of [...requests].reverse())
            socket.write(
              JSON.stringify({ return: r.execute, id: r.id }) + "\n",
            );
      }
    }
  });
  await client.ready;
  expect(
    await Promise.all([client.command("one"), client.command("two")]),
  ).toEqual(["one", "two"]);
  expect(
    logs
      .tail({ module: "qmp" })
      .records.some((r) => r.event === "command.completed" && r.requestId),
  ).toBe(true);
  socket.destroy();
  await client.close();
});

test("split UTF-8 replies, async events, timeouts and disconnects remain independent", async () => {
  const client = new QmpClient();
  const port = await client.listen();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  socket.write(
    JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + "\n",
  );
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (request.execute === "qmp_capabilities")
        socket.write(JSON.stringify({ return: {}, id: request.id }) + "\n");
      if (request.execute === "unicode") {
        const data = Buffer.from(
          JSON.stringify({ return: "中文", id: request.id }) + "\n",
        );
        const split = data.indexOf(Buffer.from("中")) + 1;
        socket.write(data.subarray(0, split));
        setTimeout(() => {
          socket.write(data.subarray(split));
          socket.write(JSON.stringify({ event: "STOP", data: {} }) + "\n");
        }, 10);
      }
    }
  });
  try {
    await client.ready;
    const event = new Promise<any>((r) => client.once("event", r));
    expect(await client.command("unicode")).toBe("中文");
    expect((await event).event).toBe("STOP");
    await expect(client.command("unanswered", undefined, 20)).rejects.toThrow(
      /timeout/,
    );
    const pending = client.command("disconnect");
    socket.destroy();
    await expect(pending).rejects.toThrow(/disconnected|ECONNRESET/);
  } finally {
    socket.destroy();
    await client.close();
  }
});
