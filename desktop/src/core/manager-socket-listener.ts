import { spawn, type ChildProcess } from "node:child_process";
import { Server, type Socket } from "node:net";
import { mkdtemp, lstat, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type {
  ManagerEndpointDirectory,
  OwnedManagerEndpoint,
} from "./manager-endpoints";
import { ManagerProtocolError } from "./manager-protocol";

// IPC duplicates the listening FD. The receiver has no libuv bound pathname,
// so closing it cannot unlink a replacement at the published endpoint.
// The bootstrap process deliberately exits without Server.close(): only the
// parent performs inode-checked cleanup of its private bind pathname.
const binder = String.raw`
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const server = net.createServer(socket => socket.destroy());
const fail = () => process.exit(2);
process.on("disconnect", fail);
process.on("SIGTERM", fail);
server.on("error", fail);
server.listen(process.argv[1], () => {
  try {
    fs.chmodSync(process.argv[1], 0o600);
    const stat = fs.lstatSync(process.argv[1]);
    process.send({ protocol: 1, dev: stat.dev, ino: stat.ino, uid: stat.uid }, server, error => {
      if (error) fail();
    });
  } catch { fail(); }
});
process.on("message", message => {
  if (message === "retire") process.exit(0);
  fail();
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
  const until = performance.now() + 2000;
  let cancelled = false,
    ready = false,
    retiring = false;
  let child: ChildProcess | undefined, server: Server | undefined;
  let sourceIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  let stage: string | undefined, stageIdentity: Stats | undefined;
  let childClosed: Promise<void> | undefined;
  const handles = new Set<Server>();
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
    // This unadvertised private directory exists only during FD bootstrap.
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
    const received = new Promise<{ message: unknown; server: Server }>(
      (resolve, reject) => {
        child!.on("message", (message, handle) => {
          if (handle instanceof Server) {
            handles.add(handle);
            const identity = message as {
              protocol?: number;
              uid?: number;
              dev?: number;
              ino?: number;
            } | null;
            // Even a late IPC delivery can identify our bound inode for cleanup.
            if (
              !sourceIdentity &&
              identity?.protocol === 1 &&
              identity.uid === directory.uid &&
              Number.isSafeInteger(identity.dev) &&
              Number.isSafeInteger(identity.ino)
            )
              sourceIdentity = { dev: identity.dev!, ino: identity.ino! };
            if (cancelled || ready) {
              void closeServer(handle);
              return;
            }
            ready = true;
            resolve({ message, server: handle });
          } else reject(failure());
        });
        child!.once("error", () => {
          reject(failure());
          rejectAbort(failure());
        });
        child!.once("exit", (code) => {
          if (!ready) reject(failure());
          if (!retiring || code !== 0) rejectAbort(failure());
        });
      },
    );
    const result = await wait(received);
    check();
    server = result.server;
    const message = result.message as {
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
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (cancelled) socket.destroy();
      else accept(socket);
    });
    await wait(endpoint.publishSocket(source, sourceIdentity));
    check();
    retiring = true;
    await wait(
      new Promise<void>((resolve, reject) => {
        child!.send("retire", (error) =>
          error ? reject(failure()) : resolve(),
        );
      }),
    );
    await wait(childClosed);
    if (child.exitCode !== 0) throw failure();
    check();
    return server;
  } catch (error) {
    cancelled = true;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    let cleanupError: unknown;
    try {
      // SIGKILL avoids any pathname cleanup in a failed bootstrap process.
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (childClosed) await bounded(childClosed, 1000);
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
      await bounded(Promise.all([...handles].map(closeServer)), 1000);
      await endpoint.close();
    }
    if (cleanupError) throw cleanupError;
  }
}
