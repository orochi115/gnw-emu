import { randomUUID } from "node:crypto";
import { createConnection, type Socket, type Server } from "node:net";
import { listenOwnedManagerSocket } from "./manager-socket-listener";
import {
  openManagerDirectory,
  type OwnedManagerEndpoint,
} from "./manager-endpoints";
import {
  encodeResponse,
  parseRequestFrame,
  ManagerProtocolError,
  MAX_FRAME_BYTES,
  MAX_CONNECTIONS,
  MAX_OUTSTANDING_REQUESTS,
  LEASE_IDLE_MS,
  type ManagerRequest,
  type ManagerServerDescriptor,
  type ManagerResponse,
  type ManagerCompletion,
} from "./manager-protocol";
import {
  deadline,
  type SessionController,
  type ManagerOwner,
  type ManagerAcquisition,
} from "./session-controller";

interface Connection {
  socket: Socket;
  buffer: Buffer;
  pending: Set<string>;
  closed: boolean;
}
export interface ManagerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}
const systemClock: ManagerClock = {
  now: () => performance.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
export interface ManagerServerOptions {
  controller: SessionController;
  directory?: string;
  platform?: NodeJS.Platform;
  clock?: ManagerClock;
  rpcTimeoutMs?: number;
}
interface Bridge {
  peer: Socket;
  upstream: Socket;
  closed: Promise<void>;
}
interface Lease {
  id: string;
  sessionId: string;
  connection: Connection;
  owner: ManagerOwner;
  abort: AbortController;
  absolute: number;
  idle: number;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  closing: boolean;
  acquisition: Promise<ManagerAcquisition>;
  native?: string;
  nativeConnected?: boolean;
  proxy?: Server;
  endpoint?: OwnedManagerEndpoint;
  bridge?: Bridge;
  connecting?: Socket;
  proxyWork?: Promise<void>;
  controls: Set<Promise<unknown>>;
  finish?: Promise<Record<string, unknown>>;
}
const failed: ManagerCompletion = {
  success: false,
  managerUploaded: false,
  memoryWritten: false,
  executionChanged: false,
};
export async function startManagerSessionServer(options: ManagerServerOptions) {
  const clock = options.clock ?? systemClock;
  const rpcTimeout = options.rpcTimeoutMs ?? 10000;
  if (!Number.isFinite(rpcTimeout) || rpcTimeout < 1 || rpcTimeout > 10000)
    throw new ManagerProtocolError("INVALID_REQUEST", "Invalid RPC timeout");
  const directory = await openManagerDirectory({
    directory: options.directory,
    platform: options.platform,
  });
  const serverId = randomUUID();
  const endpoint = await directory.socket("rpc", serverId);
  const descriptor: ManagerServerDescriptor = {
    protocol: 1,
    serverId,
    pid: process.pid,
    endpoint: endpoint.path,
  };
  let publication: OwnedManagerEndpoint | undefined;
  let closed = false,
    closeWork: Promise<void> | undefined,
    lease: Lease | undefined;
  const connections = new Set<Connection>();
  const closingLeases = new Set<Promise<unknown>>();
  let server: Server | undefined;
  const acceptRpc = (socket: Socket) => {
    if (closed || connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const connection: Connection = {
      socket,
      buffer: Buffer.alloc(0),
      pending: new Set(),
      closed: false,
    };
    connections.add(connection);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      connection.closed = true;
      connections.delete(connection);
      if (lease?.connection === connection)
        void finishLease(lease, failed).catch(() => {});
    });
    socket.on("data", (data) => {
      if (connection.closed) return;
      connection.buffer = Buffer.concat([connection.buffer, data]);
      let end: number;
      while ((end = connection.buffer.indexOf(10)) >= 0) {
        const frame = connection.buffer.subarray(0, end + 1);
        connection.buffer = connection.buffer.subarray(end + 1);
        try {
          const request = parseRequestFrame(frame);
          if (
            connection.pending.has(request.id) ||
            connection.pending.size >= MAX_OUTSTANDING_REQUESTS
          )
            throw new ManagerProtocolError(
              "BUSY",
              "Too many outstanding requests",
            );
          connection.pending.add(request.id);
          const work = dispatch(connection, request);
          const timeout =
            request.method === "control" && request.params.action === "press"
              ? Math.min(
                  40000,
                  request.params.value.durationMs + rpcTimeout,
                  Math.max(1, (lease?.absolute ?? clock.now()) - clock.now()),
                )
              : rpcTimeout;
          void deadline(work, timeout, "manager-rpc")
            .then(
              (result) =>
                reply(connection, {
                  protocol: 1,
                  id: request.id,
                  ok: true,
                  result,
                }),
              (error) => {
                if (
                  !(error instanceof ManagerProtocolError) &&
                  lease?.connection === connection &&
                  !["hello", "list", "heartbeat", "status"].includes(
                    request.method,
                  )
                )
                  void finishLease(lease, failed).catch(() => {});
                reply(connection, failure(request.id, error));
              },
            )
            .finally(() => connection.pending.delete(request.id));
        } catch (error) {
          let id = "invalid";
          try {
            const value = JSON.parse(frame.toString());
            if (
              typeof value.id === "string" &&
              value.id.length &&
              value.id.length <= 128
            )
              id = value.id;
          } catch {}
          reply(connection, failure(id, error));
        }
      }
      if (connection.buffer.length >= MAX_FRAME_BYTES) {
        reply(
          connection,
          failure(
            "invalid",
            new ManagerProtocolError(
              "INVALID_REQUEST",
              "Manager frame exceeds size limit",
            ),
          ),
        );
        socket.destroy();
      }
    });
  };
  function reply(connection: Connection, response: ManagerResponse) {
    if (!connection.closed && !connection.socket.destroyed) {
      if (!connection.socket.write(encodeResponse(response))) {
        connection.socket.pause();
        connection.socket.once("drain", () => {
          if (!connection.closed) connection.socket.resume();
        });
      }
    }
  }
  function failure(id: string, error: unknown): ManagerResponse {
    return {
      protocol: 1,
      id,
      ok: false,
      error:
        error instanceof ManagerProtocolError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL", message: "Management operation failed" },
    };
  }
  function check(current: Lease, closing = false) {
    if (
      lease !== current ||
      closed ||
      options.controller.managerSession()?.sessionId !== current.sessionId
    )
      throw new ManagerProtocolError(
        "STALE_SESSION",
        "Managed session is no longer active",
      );
    if (
      !closing &&
      (current.closing ||
        current.abort.signal.aborted ||
        clock.now() >= current.absolute ||
        clock.now() >= current.idle)
    )
      throw new ManagerProtocolError("LEASE_EXPIRED", "Management lease ended");
  }
  function owned(connection: Connection, sessionId: string, leaseId: string) {
    if (options.controller.managerSession()?.sessionId !== sessionId)
      throw new ManagerProtocolError(
        "STALE_SESSION",
        "Session identity does not match",
      );
    const current = lease;
    if (!current)
      throw new ManagerProtocolError("LEASE_EXPIRED", "Management lease ended");
    if (
      current.connection !== connection ||
      current.id !== leaseId ||
      current.sessionId !== sessionId
    )
      throw new ManagerProtocolError(
        "NOT_OWNER",
        "Management owner does not match",
      );
    check(current);
    return current;
  }
  function schedule(current: Lease) {
    if (current.timer) clock.clearTimeout(current.timer);
    current.timer = clock.setTimeout(
      () => {
        if (lease !== current || current.abort.signal.aborted) return;
        if (clock.now() >= Math.min(current.absolute, current.idle))
          void finishLease(current, failed).catch(() => {});
        else schedule(current);
      },
      Math.max(1, Math.min(current.absolute, current.idle) - clock.now()),
    );
  }
  async function dispatch(
    connection: Connection,
    request: ManagerRequest,
  ): Promise<Record<string, unknown>> {
    if (closed || connection.closed)
      throw new ManagerProtocolError(
        "STALE_SESSION",
        "Management service closed",
      );
    if (request.method === "hello") {
      if (request.params.serverId !== serverId)
        throw new ManagerProtocolError(
          "STALE_SESSION",
          "Server identity does not match",
        );
      return { serverId, protocol: 1 };
    }
    if (request.method === "list") {
      const session = options.controller.managerSession();
      return { sessions: session ? [session] : [] };
    }
    if (request.method === "acquire") {
      const session = options.controller.managerSession();
      if (!session || session.sessionId !== request.params.sessionId)
        throw new ManagerProtocolError(
          "STALE_SESSION",
          "Session identity does not match",
        );
      if (lease) throw new ManagerProtocolError("BUSY", "Session is busy");
      const abort = new AbortController(),
        expiresAt = Date.now() + request.params.timeoutMs;
      const owner: ManagerOwner = {
        operation: request.params.operation,
        deadlineMs: expiresAt,
        signal: abort.signal,
      };
      const current: Lease = {
        id: randomUUID(),
        sessionId: session.sessionId,
        connection,
        owner,
        abort,
        absolute: clock.now() + request.params.timeoutMs,
        idle: clock.now() + LEASE_IDLE_MS,
        expiresAt,
        closing: false,
        acquisition: Promise.resolve(
          undefined as unknown as ManagerAcquisition,
        ),
        controls: new Set(),
      };
      lease = current;
      current.acquisition = options.controller.beginManager(
        session.sessionId,
        owner,
      );
      schedule(current);
      try {
        const acquired = await current.acquisition;
        check(current);
        current.native = acquired.gdbEndpoint;
        current.endpoint = await directory.socket("lease");
        check(current);
        current.proxy = await listenOwnedManagerSocket(
          directory,
          current.endpoint,
          (peer) => connectProxy(current, peer),
          current.abort.signal,
        );
        check(current);
        await current.endpoint.secure();
        check(current);
        return {
          leaseId: current.id,
          sessionId: current.sessionId,
          gdbEndpoint: current.endpoint.path,
          initial: acquired.initial,
          expiresAt,
        };
      } catch (error) {
        await finishLease(current, failed).catch(() => {});
        throw error;
      }
    }
    const current = owned(
      connection,
      request.params.sessionId,
      request.params.leaseId,
    );
    if (request.method === "heartbeat" || request.method === "status") {
      if (request.method === "heartbeat") {
        current.idle = clock.now() + LEASE_IDLE_MS;
        schedule(current);
      }
      return {
        session: options.controller.managerSession()!,
        expiresAt: current.expiresAt,
      };
    }
    if (request.method === "mark") {
      const { sessionId: _s, leaseId: _l, ...mutations } = request.params;
      return options.controller.markManager(current.owner, mutations);
    }
    if (request.method === "control") {
      const { sessionId: _s, leaseId: _l, ...control } = request.params;
      const work = options.controller.managerControl(current.owner, control);
      current.controls.add(work);
      try {
        const result = await work;
        check(current);
        return result;
      } finally {
        current.controls.delete(work);
      }
    }
    return finishLease(current, request.params.completion);
  }
  function connectProxy(current: Lease, peer: Socket) {
    peer.on("error", () => peer.destroy());
    peer.pause();
    try {
      check(current);
      if (
        current.connecting ||
        (current.bridge && !current.bridge.peer.destroyed)
      )
        throw new ManagerProtocolError(
          "BUSY",
          "GDB connection is already active",
        );
    } catch {
      peer.destroy();
      return;
    }
    current.connecting = peer;
    const prior = current.bridge;
    current.proxyWork = (async () => {
      if (prior) await deadline(prior.closed, 1000, "manager-gdb-reconnect");
      check(current);
      if (current.nativeConnected) {
        await nativeDisconnectBarrier(current.native!);
        check(current);
      }
      if (peer.destroyed) return;
      current.nativeConnected = true;
      const upstream = createConnection({ path: current.native! });
      const bridge: Bridge = { peer, upstream, closed: Promise.resolve() };
      current.bridge = bridge;
      const peerClosed = socketClosed(peer),
        upstreamClosed = socketClosed(upstream);
      bridge.closed = Promise.all([peerClosed, upstreamClosed]).then(() => {
        if (current.bridge === bridge) current.bridge = undefined;
      });
      const stop = () => {
        peer.unpipe(upstream);
        upstream.unpipe(peer);
        peer.destroy();
        upstream.destroy();
      };
      peer.on("close", stop);
      upstream.on("close", stop);
      upstream.on("error", stop);
      upstream.once("connect", () => {
        try {
          check(current);
          peer.pipe(upstream);
          upstream.pipe(peer);
          peer.resume();
        } catch {
          stop();
        }
      });
    })()
      .catch(() => peer.destroy())
      .then(() => {})
      .finally(() => {
        if (current.connecting === peer) current.connecting = undefined;
      });
  }
  function finishLease(
    current: Lease,
    completion: ManagerCompletion,
    revoked = false,
  ): Promise<Record<string, unknown>> {
    // A later disconnect/revoke must strengthen an already running successful release.
    if (!completion.success || revoked) {
      current.abort.abort();
      if (current.timer) clock.clearTimeout(current.timer);
    }
    if (current.finish) return current.finish;
    // Closing rejects new work but does not disable the fixed lease deadline.
    current.closing = true;
    // Close both directions synchronously before cancellation can finish the controller.
    const bridge = current.bridge;
    current.connecting?.destroy();
    bridge?.peer.destroy();
    bridge?.upstream.destroy();
    const proxyClosed = current.proxy
      ? closeListener(current.proxy)
      : Promise.resolve();
    if (!completion.success || revoked) current.abort.abort();
    const finish = (async () => {
      let success =
        completion.success && !revoked && !current.abort.signal.aborted;
      try {
        const acquired = await deadline(
          current.acquisition.catch(() => undefined),
          1000,
          "manager-admission-close",
        );
        current.native ??= acquired?.gdbEndpoint;
        if (current.proxyWork)
          await deadline(
            current.proxyWork,
            3000,
            "manager-gdb-connection-close",
          );
        if (bridge) await deadline(bridge.closed, 1000, "manager-proxy-close");
        await deadline(proxyClosed, 1000, "manager-proxy-listener-close");
        try {
          await deadline(
            Promise.allSettled([...current.controls]),
            1000,
            "manager-control-close",
          );
        } catch {
          success = false;
          current.abort.abort();
        }
        if (success) {
          check(current, true);
          if (clock.now() >= Math.min(current.absolute, current.idle))
            throw new ManagerProtocolError(
              "LEASE_EXPIRED",
              "Management lease ended during release",
            );
        }
        if (
          !revoked &&
          current.native &&
          options.controller.managerSession()?.sessionId === current.sessionId
        )
          await nativeDisconnectBarrier(current.native);
        if (success) {
          check(current, true);
          if (clock.now() >= Math.min(current.absolute, current.idle))
            throw new ManagerProtocolError(
              "LEASE_EXPIRED",
              "Management lease ended during release",
            );
        }
        return await options.controller.endManager(current.owner, {
          ...completion,
          success:
            success &&
            !current.abort.signal.aborted &&
            !current.connection.closed,
        });
      } catch (error) {
        current.abort.abort();
        await options.controller
          .endManager(current.owner, failed)
          .catch(() => {});
        if (revoked) return {};
        throw error;
      } finally {
        if (current.timer) clock.clearTimeout(current.timer);
        await current.endpoint?.close();
        if (lease === current) lease = undefined;
      }
    })();
    current.finish = finish;
    closingLeases.add(finish);
    void finish.then(
      () => closingLeases.delete(finish),
      () => closingLeases.delete(finish),
    );
    return finish;
  }
  const revoke = (event: { sessionId: string; owner: ManagerOwner }) => {
    const current = lease;
    if (current?.sessionId !== event.sessionId || current.owner !== event.owner)
      return;
    current.connection.socket.destroy();
    void finishLease(current, failed, true).catch(() => {});
  };
  options.controller.on("manager-revoke", revoke);
  async function close() {
    if (closeWork) return closeWork;
    closed = true;
    const current = lease;
    // Withdraw admission/discovery before waiting for native cleanup.
    const finishing = current
      ? finishLease(current, failed).catch(() => {})
      : Promise.resolve();
    for (const connection of connections) connection.socket.destroy();
    const listenerClosed = closeListener(server);
    closeWork = (async () => {
      const results = await Promise.allSettled([
        publication?.close(),
        listenerClosed,
        finishing,
      ]);
      await Promise.allSettled([...closingLeases]);
      options.controller.off("manager-revoke", revoke);
      await endpoint.close();
      const error = results.find((result) => result.status === "rejected");
      if (error?.status === "rejected") throw error.reason;
    })();
    return closeWork;
  }
  try {
    server = await listenOwnedManagerSocket(directory, endpoint, acceptRpc);
    await endpoint.secure();
    publication = await directory.publishDescriptor(descriptor);
    return { descriptor, descriptorPath: publication.path, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
function closeListener(server: Server | undefined) {
  return new Promise<void>((resolve) => {
    if (!server?.listening) resolve();
    else server.close(() => resolve());
  });
}
function socketClosed(socket: Socket) {
  return new Promise<void>((resolve) => {
    if (socket.closed) resolve();
    else socket.once("close", () => resolve());
  });
}
/** A newly accepted native RSP response proves the previous single-client channel was retired. */
async function nativeDisconnectBarrier(path: string) {
  const socket = createConnection({ path });
  socket.on("error", () => {});
  const until = performance.now() + 2000;
  let bytes = 0,
    buffer = Buffer.alloc(0),
    resends = 0;
  const payload = Buffer.from("qSupported");
  const sum = [...payload].reduce((a, b) => a + b, 0) & 255;
  const packet = Buffer.from(
    `$qSupported#${sum.toString(16).padStart(2, "0")}`,
  );
  try {
    await deadline(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      }),
      Math.max(1, until - performance.now()),
      "native-gdb-barrier-connect",
    );
    await deadline(
      new Promise<void>((resolve, reject) => {
        socket.once("close", () =>
          reject(new Error("Native GDB barrier disconnected")),
        );
        socket.once("error", reject);
        socket.on("data", (data) => {
          bytes += data.length;
          if (bytes > MAX_FRAME_BYTES) {
            reject(new Error("Native GDB barrier response exceeds limit"));
            return;
          }
          buffer = Buffer.concat([buffer, data]);
          for (;;) {
            const start = buffer.indexOf(36);
            if (start < 0) {
              for (const byte of buffer) {
                if (byte === 45) {
                  if (++resends > 4) {
                    reject(new Error("Native GDB barrier cannot synchronize"));
                    return;
                  }
                  socket.write(packet);
                }
              }
              buffer = Buffer.alloc(0);
              return;
            }
            // Negative ACK before a packet requires a bounded retransmission.
            for (const byte of buffer.subarray(0, start))
              if (byte === 45) {
                if (++resends > 4) {
                  reject(new Error("Native GDB barrier cannot synchronize"));
                  return;
                }
                socket.write(packet);
              }
            buffer = buffer.subarray(start);
            const end = buffer.indexOf(35);
            if (end < 0 || buffer.length < end + 3) return;
            const body = buffer.subarray(1, end);
            const checksum = buffer.subarray(end + 1, end + 3).toString();
            buffer = buffer.subarray(end + 3);
            if (
              !/^[a-f0-9]{2}$/i.test(checksum) ||
              parseInt(checksum, 16) !==
                ([...body].reduce((a, b) => a + b, 0) & 255)
            ) {
              reject(new Error("Native GDB barrier checksum is invalid"));
              return;
            }
            socket.write("+");
            const text = body.toString();
            if (/^PacketSize=[a-f0-9]+(?:;[^\r\n]*)?$/i.test(text)) {
              resolve();
              return;
            }
            if (!/^T[0-9a-f]{2}|^S[0-9a-f]{2}/i.test(text)) {
              reject(new Error("Unexpected native GDB barrier response"));
              return;
            }
          }
        });
        socket.write(packet);
      }),
      Math.max(1, until - performance.now()),
      "native-gdb-barrier-response",
    );
  } finally {
    const ended = socketClosed(socket);
    socket.destroy();
    await deadline(ended, 1000, "native-gdb-barrier-close");
  }
}
