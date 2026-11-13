import { randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  mkdtemp,
  lstat,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join, basename } from "node:path";
import type { ChildProcess } from "node:child_process";
import { deadline } from "../../src/core/session-controller";
import { openManagerDirectory } from "../../src/core/manager-endpoints";
import { listenOwnedManagerSocket } from "../../src/core/manager-socket-listener";

const observed = vi.hoisted(() => ({
  children: [] as ChildProcess[],
  configuration: undefined as { port: number; token: string } | undefined,
  slow: false,
  missingExecutable: false,
  replaceSource: false as false | "file" | "socket",
  peers: [] as Server[],
  beforeDelivery: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (observed.slow)
        args[1] = [
          "-e",
          `setTimeout(() => { ${args[1]![1]} }, 4000)`,
          args[1]![2],
        ];
      if (observed.missingExecutable)
        args[0] = "/nonexistent-gnw-socket-binder";
      const child = actual.spawn(...args);
      const send = child.send.bind(child);
      child.send = ((...values: Parameters<ChildProcess["send"]>) => {
        const message = values[0];
        if (
          typeof message === "object" &&
          message !== null &&
          "token" in message
        )
          observed.configuration = message as { port: number; token: string };
        return send(...values);
      }) as ChildProcess["send"];
      if (observed.replaceSource || observed.beforeDelivery) {
        const on = child.on.bind(child);
        child.on = ((event: string, listener: (...args: unknown[]) => void) => {
          if (event !== "message") return on(event, listener);
          return on("message", async (...delivered: unknown[]) => {
            observed.beforeDelivery?.();
            if (!observed.replaceSource) {
              listener(...delivered);
              return;
            }
            const source = args[1]![2];
            await unlink(source);
            if (observed.replaceSource === "file") {
              await writeFile(source, "foreign bootstrap replacement", {
                mode: 0o600,
              });
            } else {
              const peer = createServer((socket) =>
                socket.end("foreign bootstrap socket"),
              );
              observed.peers.push(peer);
              await new Promise<void>((resolve, reject) => {
                peer.once("error", reject);
                peer.listen(source, resolve);
              });
            }
            listener(...delivered);
          });
        }) as typeof child.on;
      }
      observed.children.push(child);
      return child;
    },
  };
});

async function setup() {
  observed.children = [];
  observed.configuration = undefined;
  observed.slow = false;
  observed.missingExecutable = false;
  observed.replaceSource = false;
  observed.peers = [];
  observed.beforeDelivery = undefined;
  const root = await mkdtemp("/tmp/gnw-fd-listener-test-");
  const directory = await openManagerDirectory({ directory: root });
  const endpoint = await directory.socket("lease");
  return {
    root,
    directory,
    endpoint,
    async cleanup() {
      observed.slow = false;
      observed.missingExecutable = false;
      for (const child of observed.children) {
        expect(
          child.exitCode !== null || child.signalCode !== null || !child.pid,
        ).toBe(true);
        if (child.pid) expect(() => process.kill(child.pid!, 0)).toThrow();
      }
      for (const peer of observed.peers)
        await new Promise<void>((r) => peer.close(() => r()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("actual relay listener keeps its helper while serving and reaps it on close without removing replacement", async () => {
  const f = await setup();
  let server: Awaited<ReturnType<typeof listenOwnedManagerSocket>> | undefined;
  try {
    server = await listenOwnedManagerSocket(f.directory, f.endpoint, (socket) =>
      socket.end("relay listener"),
    );
    expect(observed.children).toHaveLength(1);
    expect(observed.children[0].exitCode).toBe(null);
    expect(() => process.kill(observed.children[0].pid!, 0)).not.toThrow();
    expect(await readdir(f.root)).toEqual([basename(f.endpoint.path)]);
    expect((await lstat(f.endpoint.path)).mode & 0o7777).toBe(0o600);
    const socket = createConnection(f.endpoint.path);
    try {
      expect(
        await deadline(
          new Promise<string>((resolve, reject) => {
            socket.once("data", (d) => resolve(d.toString()));
            socket.once("error", reject);
          }),
          1000,
          "fd-listener-reply",
        ),
      ).toBe("relay listener");
    } finally {
      socket.destroy();
    }
    await unlink(f.endpoint.path);
    await writeFile(f.endpoint.path, "replacement", { mode: 0o600 });
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await f.endpoint.close();
    expect(await readFile(f.endpoint.path, "utf8")).toBe("replacement");
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("abort during actual listener publication reaps helper and prevents a delayed link", async () => {
  const f = await setup(),
    abort = new AbortController();
  let proceed!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (proceed = r)),
    ready = new Promise<void>((r) => (entered = r));
  const publish = f.endpoint.publishSocket.bind(f.endpoint);
  const spy = vi
    .spyOn(f.endpoint, "publishSocket")
    .mockImplementation(async (...args) => {
      entered();
      await gate;
      return publish(...args);
    });
  const work = listenOwnedManagerSocket(
    f.directory,
    f.endpoint,
    (s) => s.destroy(),
    abort.signal,
  );
  work.catch(() => {});
  try {
    await deadline(ready, 1000, "handoff-entered");
    abort.abort();
    await expect(deadline(work, 800, "abort-cleanup")).rejects.toMatchObject({
      code: "LEASE_EXPIRED",
    });
    expect(await readdir(f.root)).toEqual([]);
    proceed();
    await new Promise<void>((r) => setImmediate(r));
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    proceed();
    await work.catch(() => {});
    spy.mockRestore();
    await f.cleanup();
  }
});

test("unexpected helper death after listener ready cancels pending publication immediately", async () => {
  const f = await setup();
  let proceed!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (proceed = r)),
    ready = new Promise<void>((r) => (entered = r));
  const publish = f.endpoint.publishSocket.bind(f.endpoint);
  const spy = vi
    .spyOn(f.endpoint, "publishSocket")
    .mockImplementation(async (...args) => {
      entered();
      await gate;
      return publish(...args);
    });
  const work = listenOwnedManagerSocket(f.directory, f.endpoint, (s) =>
    s.destroy(),
  );
  work.catch(() => {});
  try {
    await deadline(ready, 1000, "helper-death-gate");
    observed.children[0].kill("SIGKILL");
    await expect(
      deadline(work, 800, "helper-death-immediate-cleanup"),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await readdir(f.root)).toEqual([]);
    proceed();
    await new Promise<void>((r) => setImmediate(r));
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    proceed();
    await work.catch(() => {});
    spy.mockRestore();
    await f.cleanup();
  }
});

test("private socket publication collision retains the foreign file and reaps helper", async () => {
  const f = await setup();
  try {
    await writeFile(f.endpoint.path, "foreign", { mode: 0o600 });
    const before = await lstat(f.endpoint.path);
    await expect(
      listenOwnedManagerSocket(f.directory, f.endpoint, (s) => s.destroy()),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect((await lstat(f.endpoint.path)).ino).toBe(before.ino);
    expect(await readFile(f.endpoint.path, "utf8")).toBe("foreign");
    expect(await readdir(f.root)).toEqual([basename(f.endpoint.path)]);
  } finally {
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("unresponsive real binder is killed at a fixed startup deadline and leaves no files", async () => {
  const f = await setup();
  observed.slow = true;
  const start = performance.now();
  try {
    await expect(
      listenOwnedManagerSocket(f.directory, f.endpoint, (s) => s.destroy()),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(performance.now() - start).toBeLessThan(2800);
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("spawn error cleans bootstrap directory without a helper process", async () => {
  const f = await setup();
  observed.missingExecutable = true;
  try {
    await expect(
      listenOwnedManagerSocket(f.directory, f.endpoint, (s) => s.destroy()),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("already cancelled creation never starts a binder", async () => {
  const f = await setup(),
    abort = new AbortController();
  abort.abort();
  try {
    await expect(
      listenOwnedManagerSocket(
        f.directory,
        f.endpoint,
        (s) => s.destroy(),
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(observed.children).toHaveLength(0);
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("cancellation at IPC delivery still reaps the helper and cleans its identified inode", async () => {
  const f = await setup(),
    abort = new AbortController();
  observed.beforeDelivery = () => abort.abort();
  try {
    await expect(
      listenOwnedManagerSocket(
        f.directory,
        f.endpoint,
        (s) => s.destroy(),
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.endpoint.close();
    await f.cleanup();
  }
});

test.each(["file", "socket"] as const)(
  "a bootstrap %s replacement is never claimed as the binder inode",
  async (kind) => {
    const f = await setup();
    observed.replaceSource = kind;
    try {
      await expect(
        listenOwnedManagerSocket(f.directory, f.endpoint, (s) => s.destroy()),
      ).rejects.toBeDefined();
      const entries = await readdir(f.root);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^\.b-/);
      const source = join(f.root, entries[0], "s");
      if (kind === "file")
        expect(await readFile(source, "utf8")).toBe(
          "foreign bootstrap replacement",
        );
      else {
        expect((await lstat(source)).isSocket()).toBe(true);
        const client = createConnection(source);
        try {
          expect(
            await deadline(
              new Promise<string>((r, j) => {
                client.once("data", (d) => r(d.toString()));
                client.once("error", j);
              }),
              1000,
              "foreign-bootstrap-reply",
            ),
          ).toBe("foreign bootstrap socket");
        } finally {
          client.destroy();
        }
      }
      expect(await lstat(f.endpoint.path).catch((e) => e.code)).toBe("ENOENT");
    } finally {
      await f.endpoint.close();
      await f.cleanup();
    }
  },
);

test("relay rejects wrong credentials and expires silent TCP peers before delivering any bytes", async () => {
  const f = await setup();
  let accepted = 0;
  const server = await listenOwnedManagerSocket(
    f.directory,
    f.endpoint,
    (s) => {
      accepted++;
      s.destroy();
    },
  );
  try {
    const address = server.address();
    expect(address).toMatchObject({ address: "127.0.0.1" });
    const port = (address as { port: number }).port;
    for (const credentials of ["x".repeat(64), undefined]) {
      const socket = createConnection({ port, host: "127.0.0.1" });
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      socket.on("error", () => {});
      if (credentials) socket.write(credentials + "unauthorized payload");
      try {
        await deadline(closed, 1800, "unauthenticated-peer-closed");
      } finally {
        socket.destroy();
      }
    }
    expect(accepted).toBe(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("fragmented authentication preserves coalesced payload and the relay transfers a large request through EOF", async () => {
  const f = await setup();
  let accepted = 0;
  const server = await listenOwnedManagerSocket(
    f.directory,
    f.endpoint,
    (socket) => {
      accepted++;
      socket.pipe(socket);
    },
  );
  try {
    const configuration = observed.configuration!;
    const client = createConnection({
      port: configuration.port,
      host: "127.0.0.1",
    });
    const chunks: Buffer[] = [];
    client.on("data", (chunk) => chunks.push(chunk));
    const end = new Promise<void>((r, j) => {
      client.once("end", r);
      client.once("error", j);
    });
    const payload = randomBytes(1024 * 1024);
    try {
      client.write(configuration.token.slice(0, 13));
      await new Promise((r) => setTimeout(r, 20));
      expect(accepted).toBe(0);
      client.end(
        Buffer.concat([Buffer.from(configuration.token.slice(13)), payload]),
      );
      await deadline(end, 2000, "fragmented-auth-echo");
      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
      expect(accepted).toBe(1);
    } finally {
      client.destroy();
    }
    // The public Unix endpoint must also retain bytes and a client's half-close.
    const unix = createConnection(f.endpoint.path);
    const reply: Buffer[] = [];
    unix.on("data", (chunk) => reply.push(chunk));
    const done = new Promise<void>((r, j) => {
      unix.once("end", r);
      unix.once("error", j);
    });
    try {
      unix.end(payload);
      await deadline(done, 2000, "unix-relay-echo");
      expect(Buffer.concat(reply).length).toBe(payload.length);
      expect(Buffer.concat(reply).equals(payload)).toBe(true);
      expect(accepted).toBe(2);
    } finally {
      unix.destroy();
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("closing with a pending TCP handshake reaps the helper and runtime helper death withdraws its endpoint", async () => {
  const f = await setup();
  let server: Server | undefined;
  try {
    server = await listenOwnedManagerSocket(f.directory, f.endpoint, (s) =>
      s.destroy(),
    );
    const client = createConnection({
      host: "127.0.0.1",
      port: observed.configuration!.port,
    });
    const closed = new Promise<void>((r) => client.once("close", () => r()));
    client.on("error", () => {});
    try {
      await new Promise<void>((r, j) => {
        client.once("connect", r);
        client.once("error", j);
      });
      await deadline(
        new Promise<void>((r) => server!.close(() => r())),
        1000,
        "relay-close",
      );
      await deadline(closed, 500, "pending-peer-close");
    } finally {
      client.destroy();
    }
    expect(observed.children[0].exitCode).toBe(0);
    await f.endpoint.close();
    const next = await f.directory.socket("lease");
    server = await listenOwnedManagerSocket(f.directory, next, (s) =>
      s.destroy(),
    );
    const stopped = new Promise<void>((r) => server!.once("close", () => r()));
    observed.children.at(-1)!.kill("SIGKILL");
    await deadline(stopped, 1000, "dead-helper-listener-close");
    await deadline(
      (async () => {
        while ((await lstat(next.path).catch(() => undefined)) !== undefined)
          await new Promise((r) => setTimeout(r, 5));
      })(),
      1000,
      "dead-helper-endpoint-withdrawn",
    );
    await next.close();
  } finally {
    if (server?.listening)
      await new Promise<void>((r) => server!.close(() => r()));
    await f.endpoint.close();
    await f.cleanup();
  }
});

test("a trickling unauthenticated peer cannot extend the fixed authentication deadline", async () => {
  const f = await setup();
  let accepted = 0;
  const server = await listenOwnedManagerSocket(
    f.directory,
    f.endpoint,
    (s) => {
      accepted++;
      s.destroy();
    },
  );
  const peer = createConnection({
    host: "127.0.0.1",
    port: observed.configuration!.port,
  });
  peer.on("error", () => {});
  const closed = new Promise<void>((r) => peer.once("close", () => r()));
  const trickle = setInterval(() => peer.write("a"), 100);
  try {
    await deadline(closed, 1600, "fixed-authentication-deadline");
    expect(accepted).toBe(0);
  } finally {
    clearInterval(trickle);
    peer.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await f.endpoint.close();
    await f.cleanup();
  }
});
