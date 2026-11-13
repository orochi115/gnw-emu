import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, lstat, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type {
  ManagerEndpointDirectory,
  OwnedManagerEndpoint,
} from "./manager-endpoints";
import { listenAuthenticatedLoopback } from "./windows-manager-transport";
import { ManagerProtocolError } from "./manager-protocol";

// Electron/Chromium can crash on shutdown after Node IPC receives a listening
// FD (reproduced on macOS with Electron 39 and 40). Keep the Unix listener in an
// attached helper and relay bytes over authenticated loopback TCP instead.
// The helper exits without Server.close(), which could unlink a foreign socket
// replacing its original bind pathname. Only the parent checks/unlinks inodes.
const binder = String.raw`
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const fail = () => process.exit(2);
process.on("disconnect", fail);
process.on("SIGTERM", fail);
let configured = false;
process.on("message", message => {
  if (message === "retire") process.exit(0);
  if (configured || !message || message.protocol !== 1 ||
      !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
      typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)) fail();
  configured = true;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    const relay = net.createConnection({ host: "127.0.0.1", port: message.port, allowHalfOpen: true });
    relay.setNoDelay(true);
    socket.on("error", () => relay.destroy());
    relay.on("error", () => socket.destroy());
    // A normal half-close must drain the other socket's queued writes first.
    socket.on("close", error => {
      if (error || !socket.readableEnded || !socket.writableFinished) relay.destroy();
    });
    relay.on("close", error => {
      if (error || !relay.readableEnded || !relay.writableFinished) socket.destroy();
    });
    relay.once("connect", () => {
      relay.write(message.token);
      socket.pipe(relay);
      relay.pipe(socket);
    });
  });
  server.on("error", fail);
  server.listen(process.argv[1], () => {
    try {
      fs.chmodSync(process.argv[1], 0o600);
      const stat = fs.lstatSync(process.argv[1]);
      process.send({ protocol: 1, dev: stat.dev, ino: stat.ino, uid: stat.uid }, error => {
        if (error) fail();
      });
    } catch { fail(); }
  });
});
`;

function failure(): ManagerProtocolError {
  return new ManagerProtocolError(
    "INTERNAL",
    "Could not establish private manager listener",
  );
}
function same(a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure()), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function listenOwnedManagerSocket(
  directory: ManagerEndpointDirectory,
  endpoint: OwnedManagerEndpoint,
  accept: (socket: Socket) => void,
  signal?: AbortSignal,
): Promise<Server> {
  if (endpoint.credential) {
    if (signal?.aborted) throw failure();
    const listener = await listenAuthenticatedLoopback(
      endpoint.credential.token,
      accept,
    );
    try {
      await endpoint.bind!((listener.address() as { port: number }).port);
      if (signal?.aborted) throw failure();
      return listener;
    } catch (error) {
      await closeServer(listener);
      throw error;
    }
  }
  const until = performance.now() + 2000;
  let cancelled = false,
    ready = false,
    retiring = false;
  let established = false;
  let child: ChildProcess | undefined, server: Server | undefined;
  let sourceIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  let stage: string | undefined, stageIdentity: Stats | undefined;
  let childClosed: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  let rejectAbort!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => (rejectAbort = reject));
  // The abort can precede the first raced operation.
  void interrupted.catch(() => {});
  const abort = () => {
    cancelled = true;
    rejectAbort(
      new ManagerProtocolError(
        "LEASE_EXPIRED",
        "Manager listener creation cancelled",
      ),
    );
  };
  const check = () => {
    if (cancelled || signal?.aborted)
      throw new ManagerProtocolError(
        "LEASE_EXPIRED",
        "Manager listener creation cancelled",
      );
    if (performance.now() >= until) throw failure();
  };
  const wait = <T>(work: Promise<T>) =>
    bounded(
      Promise.race([work, interrupted]),
      Math.max(1, until - performance.now()),
    );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    check();
    const token = randomBytes(32).toString("hex");
    const credential = Buffer.from(token);
    let pendingAuthentication = 0;
    server = createServer((socket) => {
      socket.setNoDelay(true);
      if (retiring || pendingAuthentication >= 32) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      pendingAuthentication++;
      let authenticated = false,
        count = 0;
      const prefix = Buffer.alloc(credential.length);
      const authenticationDeadline = setTimeout(() => socket.destroy(), 1000);
      socket.once("close", () => {
        clearTimeout(authenticationDeadline);
        sockets.delete(socket);
        if (!authenticated) pendingAuthentication--;
      });
      socket.on("error", () => socket.destroy());
      const authenticate = (chunk: Buffer) => {
        const copied = Math.min(chunk.length, prefix.length - count);
        chunk.copy(prefix, count, 0, copied);
        count += copied;
        if (count !== prefix.length) return;
        if (!timingSafeEqual(prefix, credential)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        pendingAuthentication--;
        socket.pause();
        socket.off("data", authenticate);
        clearTimeout(authenticationDeadline);
        // A client may send credentials and payload in the same TCP packet.
        if (copied < chunk.length) socket.unshift(chunk.subarray(copied));
        if (cancelled || retiring) socket.destroy();
        else {
          // Resume before delivery so accept() may pause for an asynchronous
          // GDB admission barrier without us overriding that pause afterwards.
          socket.resume();
          accept(socket);
        }
      };
      socket.on("data", authenticate);
    });
    const originalClose = server.close.bind(server);
    let closing: Promise<void> | undefined;
    server.close = ((callback?: (error?: Error) => void) => {
      if (!closing) {
        retiring = true;
        closing = (async () => {
          if (child && child.exitCode === null && child.signalCode === null) {
            if (child.connected) child.send("retire", () => {});
            const kill = setTimeout(() => child?.kill("SIGKILL"), 500);
            try {
              await bounded(childClosed!, 1000);
            } finally {
              clearTimeout(kill);
            }
          } else if (childClosed) await childClosed;
          for (const socket of sockets) socket.destroy();
          if (server!.listening)
            await new Promise<void>((resolve) =>
              originalClose(() => resolve()),
            );
        })();
      }
      void closing.then(
        () => callback?.(),
        (error) => callback?.(error),
      );
      return server!;
    }) as Server["close"];
    await wait(
      new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", reject);
          resolve();
        });
      }),
    );
    check();
    // This unadvertised private directory exists only during listener bootstrap.
    stage = await mkdtemp(join(directory.path, ".b-"));
    stageIdentity = await lstat(stage);
    if (
      !stageIdentity.isDirectory() ||
      stageIdentity.uid !== directory.uid ||
      (stageIdentity.mode & 0o7777) !== 0o700
    )
      throw failure();
    check();
    const source = join(stage, "s");
    child = spawn(process.execPath, ["-e", binder, source], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    childClosed = new Promise<void>((resolve) =>
      child!.once("close", () => resolve()),
    );
    const received = new Promise<unknown>((resolve, reject) => {
      child!.on("message", (message) => {
        const identity = message as {
          protocol?: number;
          uid?: number;
          dev?: number;
          ino?: number;
        } | null;
        // Late delivery still identifies our inode for cancellation cleanup.
        if (
          !sourceIdentity &&
          identity?.protocol === 1 &&
          identity.uid === directory.uid &&
          Number.isSafeInteger(identity.dev) &&
          Number.isSafeInteger(identity.ino)
        )
          sourceIdentity = { dev: identity.dev!, ino: identity.ino! };
        if (ready) return;
        ready = true;
        resolve(message);
      });
      child!.once("error", () => {
        reject(failure());
        rejectAbort(failure());
      });
      child!.once("exit", () => {
        if (!ready) reject(failure());
        if (!retiring) {
          cancelled = true;
          rejectAbort(failure());
          if (established) {
            void closeServer(server!).catch(() => {});
            void endpoint.close().catch(() => {});
          }
        }
      });
      const address = server!.address();
      if (!address || typeof address === "string") {
        reject(failure());
        return;
      }
      child!.send({ protocol: 1, port: address.port, token }, (error) => {
        if (error) reject(failure());
      });
    });
    const result = await wait(received);
    check();
    const message = result as {
      protocol?: number;
      dev?: number;
      ino?: number;
      uid?: number;
    } | null;
    if (
      !message ||
      message.protocol !== 1 ||
      message.uid !== directory.uid ||
      !Number.isSafeInteger(message.dev) ||
      !Number.isSafeInteger(message.ino)
    )
      throw failure();
    // Claim only the inode reported by our binder, never an observed replacement.
    sourceIdentity = { dev: message.dev!, ino: message.ino! };
    const namedSource = await wait(lstat(source));
    if (
      !namedSource.isSocket() ||
      namedSource.uid !== directory.uid ||
      (namedSource.mode & 0o7777) !== 0o600 ||
      !same(namedSource, sourceIdentity)
    )
      throw failure();
    check();
    await wait(endpoint.publishSocket(source, sourceIdentity));
    check();
    established = true;
    return server;
  } catch (error) {
    cancelled = true;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    let cleanupError: unknown;
    try {
      // Startup failure cannot leave an attached listener or touch replacements.
      if (!established) {
        retiring = true;
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        if (childClosed) await bounded(childClosed, 1000);
      }
      if (stage && stageIdentity) {
        const current = await lstat(stage).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (
          current &&
          same(current, stageIdentity) &&
          current.uid === directory.uid &&
          current.isDirectory()
        ) {
          const source = join(stage, "s");
          const named = await lstat(source).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          // Without a binder identity, leave an unknown pathname intact.
          if (
            named &&
            sourceIdentity &&
            same(named, sourceIdentity) &&
            named.isSocket() &&
            named.uid === directory.uid
          )
            await unlink(source);
          await rmdir(stage);
        }
      }
    } catch (error) {
      cancelled = true;
      cleanupError = error;
    }
    if (cancelled) {
      for (const socket of sockets) socket.destroy();
      if (server) await bounded(closeServer(server), 1200);
      await endpoint.close();
    }
    if (cleanupError) throw cleanupError;
  }
}
