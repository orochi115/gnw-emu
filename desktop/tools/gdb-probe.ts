import { createConnection } from "node:net";

function checksum(value: string) {
  return ([...value].reduce((sum, c) => sum + c.charCodeAt(0), 0) & 255)
    .toString(16)
    .padStart(2, "0");
}

/** One read-only RSP capability request. Does not reset, resume or load firmware. */
export function probeGdb(path: string, timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "",
      completed = false;
    const finish = (error?: Error, reply?: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    const timer = setTimeout(
      () => finish(new Error("GDB capability request timed out")),
      timeout,
    );
    socket.once("connect", () => {
      const request = "qSupported:xmlRegisters=arm";
      socket.write(`$${request}#${checksum(request)}`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("ascii");
      if (buffer.length > 65536)
        return finish(new Error("GDB reply too large"));
      const start = buffer.indexOf("$"),
        end = buffer.indexOf("#", start);
      if (start < 0 || end < 0 || buffer.length < end + 3) return;
      const reply = buffer.slice(start + 1, end);
      if (buffer.slice(end + 1, end + 3).toLowerCase() !== checksum(reply))
        return finish(new Error("GDB reply checksum mismatch"));
      socket.write("+");
      if (!reply.includes("PacketSize="))
        return finish(new Error(`Unexpected GDB capability reply: ${reply}`));
      finish(undefined, reply);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("GDB disconnected before capability reply")),
    );
  });
}
