import { expect, test } from "vitest";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeGdb } from "../../tools/gdb-probe";

test.each([false, true])(
  "RSP probe verifies checksum over fragmented replies (bad=%s)",
  async (bad) => {
    const root = await mkdtemp(join(tmpdir(), "gnw-rsp-")),
      path = join(root, "gdb.sock");
    const reply = "PacketSize=1000;qXfer:features:read+";
    const checksum =
      [...reply].reduce((sum, c) => sum + c.charCodeAt(0), 0) & 255;
    const server = createServer((socket) =>
      socket.once("data", () => {
        socket.write(`+$${reply.slice(0, 10)}`);
        setTimeout(
          () =>
            socket.end(
              `${reply.slice(10)}#${bad ? "00" : checksum.toString(16).padStart(2, "0")}`,
            ),
          5,
        );
      }),
    );
    await new Promise<void>((r) => server.listen(path, r));
    try {
      if (bad) await expect(probeGdb(path)).rejects.toThrow(/checksum/);
      else expect(await probeGdb(path)).toBe(reply);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
