import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  ManagerProtocolError,
  parseServerDescriptor,
  type ManagerServerDescriptor,
  MAX_FRAME_BYTES,
} from "./manager-protocol";

type Identity = Pick<Stats, "dev" | "ino">;
function same(a: Identity, b: Identity) {
  return a.dev === b.dev && a.ino === b.ino;
}
function unsupported(message: string): never {
  throw new ManagerProtocolError("UNSUPPORTED", message);
}
function valid(info: Stats, uid: number, mode: number) {
  return info.uid === uid && (info.mode & 0o7777) === mode;
}
function rpcName(serverId: string) {
  return `r-${serverId.replaceAll("-", "").slice(0, 16).toLowerCase()}.sock`;
}

export interface OwnedManagerEndpoint {
  readonly path: string;
  /** Call immediately after binding/creating this socket to claim its inode and set mode0600. */
  secure(): Promise<void>;
  /** Remove only this handle's claimed inode. A replacement or an unclaimed path is retained. */
  close(): Promise<void>;
}

export class ManagerEndpointDirectory {
  private readonly resources = new Map<
    string,
    { identity?: Identity; kind: "socket" | "file" }
  >();
  constructor(
    readonly path: string,
    readonly uid: number,
    private identity: Identity,
  ) {}

  private async check() {
    const current = await lstat(this.path);
    if (
      !current.isDirectory() ||
      !same(current, this.identity) ||
      !valid(current, this.uid, 0o700)
    )
      unsupported("Manager directory ownership, identity or mode changed");
  }
  private within(path: string) {
    if (
      dirname(path) !== this.path ||
      path !== resolve(path) ||
      path.includes("\0")
    )
      unsupported("Manager endpoint is outside its private directory");
  }
  private own(
    path: string,
    kind: "socket" | "file",
    identity?: Identity,
  ): OwnedManagerEndpoint {
    if (this.resources.has(path))
      unsupported("Manager endpoint is already allocated");
    const resource = { kind, identity };
    this.resources.set(path, resource);
    let closed = false;
    return {
      path,
      secure: async () => {
        if (closed || this.resources.get(path) !== resource)
          unsupported("Manager endpoint is no longer owned");
        await this.check();
        const before = await lstat(path);
        if (
          before.uid !== this.uid ||
          (kind === "socket" ? !before.isSocket() : !before.isFile()) ||
          (resource.identity && !same(before, resource.identity))
        )
          unsupported("Manager endpoint is not an owned resource");
        resource.identity = before;
        await chmod(path, 0o600);
        const after = await lstat(path);
        if (!same(before, after) || !valid(after, this.uid, 0o600))
          unsupported("Manager endpoint changed while securing it");
        await this.check();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (this.resources.get(path) !== resource) return;
        try {
          await this.check();
          const current = await lstat(path);
          if (
            resource.identity &&
            same(current, resource.identity) &&
            current.uid === this.uid &&
            (kind === "socket" ? current.isSocket() : current.isFile())
          )
            await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          if (this.resources.get(path) === resource)
            this.resources.delete(path);
        }
      },
    };
  }

  async socket(
    kind: "native" | "rpc" | "lease",
    serverId?: string,
  ): Promise<OwnedManagerEndpoint> {
    await this.check();
    let name: string;
    if (kind === "rpc") {
      // Parse the identifier through the same descriptor UUID contract.
      parseServerDescriptor({
        protocol: 1,
        serverId,
        pid: process.pid,
        endpoint: "/tmp/rpc.sock",
      });
      name = rpcName(serverId!);
    } else if (kind === "native" || kind === "lease") {
      name = `${kind === "native" ? "n" : "l"}-${randomBytes(8).toString("hex")}.sock`;
    } else unsupported("Unknown manager socket kind");
    const path = join(this.path, name);
    if (Buffer.byteLength(path) > 100)
      unsupported("Manager Unix socket path is too long");
    if (this.resources.has(path))
      unsupported("Manager endpoint is already allocated");
    try {
      await lstat(path);
      unsupported("Manager endpoint already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.check();
    return this.own(path, "socket");
  }

  private async validateRpc(descriptor: ManagerServerDescriptor) {
    this.within(descriptor.endpoint);
    if (basename(descriptor.endpoint) !== rpcName(descriptor.serverId))
      unsupported("Manager RPC path does not match server identity");
    const socket = await lstat(descriptor.endpoint);
    if (!socket.isSocket() || !valid(socket, this.uid, 0o600))
      unsupported("Manager RPC socket is not private");
    return socket;
  }

  async publishDescriptor(
    value: ManagerServerDescriptor,
  ): Promise<OwnedManagerEndpoint> {
    const descriptor = parseServerDescriptor(value);
    await this.check();
    const socket = await this.validateRpc(descriptor);
    const owned = this.resources.get(descriptor.endpoint);
    if (!owned?.identity || !same(socket, owned.identity))
      unsupported("Cannot publish an unowned manager RPC endpoint");
    const path = join(this.path, `${descriptor.serverId}.json`);
    if (this.resources.has(path))
      unsupported("Manager descriptor is already owned");
    const temporary = join(
      this.path,
      `.${descriptor.serverId}.${randomUUID()}.pending`,
    );
    let temporaryIdentity: Identity | undefined;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        temporaryIdentity = await file.stat();
        await file.writeFile(JSON.stringify(descriptor) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.check();
      // Hard-link publication is atomic and cannot replace any existing name.
      await link(temporary, path);
      const info = await lstat(path);
      if (!same(info, temporaryIdentity) || !valid(info, this.uid, 0o600))
        unsupported("Manager descriptor changed during publication");
      return this.own(path, "file", info);
    } finally {
      if (temporaryIdentity) {
        const current = await lstat(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        });
        if (current && same(current, temporaryIdentity))
          await unlink(temporary);
      }
    }
  }

  async readDescriptor(path: string): Promise<ManagerServerDescriptor> {
    await this.check();
    this.within(path);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        !valid(info, this.uid, 0o600) ||
        info.size > MAX_FRAME_BYTES
      )
        unsupported("Manager descriptor is not a bounded private file");
      const data = Buffer.alloc(MAX_FRAME_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < data.length) {
        const part = await file.read(
          data,
          bytesRead,
          data.length - bytesRead,
          bytesRead,
        );
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > MAX_FRAME_BYTES)
        unsupported("Manager descriptor is too large");
      const current = await file.stat();
      const named = await lstat(path);
      if (
        bytesRead !== info.size ||
        current.size !== info.size ||
        !same(info, named) ||
        !valid(current, this.uid, 0o600) ||
        !valid(named, this.uid, 0o600)
      )
        unsupported("Manager descriptor changed while reading it");
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            data.subarray(0, bytesRead),
          ),
        );
      } catch {
        unsupported("Invalid manager descriptor JSON");
      }
      const descriptor = parseServerDescriptor(value);
      if (basename(path) !== `${descriptor.serverId}.json`)
        unsupported("Manager descriptor filename does not match identity");
      await this.validateRpc(descriptor);
      await this.check();
      return descriptor;
    } finally {
      await file.close();
    }
  }
}

export async function openManagerDirectory(
  options: {
    directory?: string;
    platform?: NodeJS.Platform;
    uid?: number;
  } = {},
): Promise<ManagerEndpointDirectory> {
  if ((options.platform ?? process.platform) === "win32")
    unsupported(
      "Current-session management requires Unix sockets on this platform",
    );
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isInteger(uid) || uid < 0)
    unsupported("Current-session management requires a Unix user identity");
  const path = options.directory ?? `/tmp/gnw-manager-${uid}`;
  if (!isAbsolute(path) || path !== resolve(path))
    unsupported("Manager directory must be an absolute normalized path");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || !valid(info, uid, 0o700))
    unsupported(
      "Manager directory must be a private directory owned by this user",
    );
  return new ManagerEndpointDirectory(path, uid, info);
}
