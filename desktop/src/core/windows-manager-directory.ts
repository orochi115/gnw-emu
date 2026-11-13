import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import {
  ManagerEndpointDirectory,
  type OwnedManagerEndpoint,
} from "./manager-endpoints";
import {
  ManagerProtocolError,
  parseServerDescriptor,
  type ManagerServerDescriptor,
  MAX_FRAME_BYTES,
} from "./manager-protocol";
import {
  checkWindowsPrivatePath,
  readWindowsEndpoint,
} from "./windows-manager-transport";
import type { Stats } from "node:fs";

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const fail = () => {
  throw new ManagerProtocolError(
    "UNSUPPORTED",
    "Windows manager resource changed or is not private",
  );
};
export class WindowsManagerDirectory extends ManagerEndpointDirectory {
  private entries = new Map<
    string,
    { identity?: Stats; endpoint: OwnedManagerEndpoint }
  >();
  constructor(
    path: string,
    private original: Stats,
  ) {
    super(path, 0, original);
  }
  private async verify() {
    const info = await lstat(this.path);
    if (!info.isDirectory() || !same(info, this.original)) fail();
    checkWindowsPrivatePath(this.path);
  }
  private withinWindows(path: string) {
    if (
      dirname(path) !== this.path ||
      path !== resolve(path) ||
      path.includes("\0")
    )
      fail();
  }
  private ownWindows(
    path: string,
    identity?: Stats,
    token?: string,
  ): OwnedManagerEndpoint {
    if (this.entries.has(path)) fail();
    const entry: { identity?: Stats; endpoint: OwnedManagerEndpoint } = {
      identity,
      endpoint: undefined!,
    };
    let closed = false;
    const endpoint: OwnedManagerEndpoint = {
      path,
      credential: token
        ? { format: 1, port: 0, pid: process.pid, token }
        : undefined,
      bind: async (port) => {
        await this.verify();
        if (closed || entry.identity || !endpoint.credential) fail();
        endpoint.credential!.port = port;
        const file = await open(path, "wx");
        try {
          entry.identity = await file.stat();
          await file.writeFile(JSON.stringify(endpoint.credential) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        checkWindowsPrivatePath(path, false, true);
        await endpoint.secure();
      },
      attachPid: async (pid) => {
        if (!endpoint.credential || !Number.isInteger(pid) || pid < 1) fail();
        await endpoint.secure();
        const file = await open(path, "r+");
        try {
          const info = await file.stat();
          if (!entry.identity || !same(info, entry.identity)) fail();
          endpoint.credential!.pid = pid;
          const data = JSON.stringify(endpoint.credential) + "\n";
          await file.write(data, 0, "utf8");
          await file.truncate(Buffer.byteLength(data));
          await file.sync();
        } finally {
          await file.close();
        }
      },
      secure: async () => {
        await this.verify();
        const info = await lstat(path);
        if (
          closed ||
          !entry.identity ||
          !info.isFile() ||
          !same(info, entry.identity)
        )
          fail();
        checkWindowsPrivatePath(path);
      },
      publishSocket: async () => fail(),
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await this.verify();
          const info = await lstat(path);
          if (entry.identity && same(info, entry.identity) && info.isFile())
            await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          this.entries.delete(path);
        }
      },
    };
    entry.endpoint = endpoint;
    this.entries.set(path, entry);
    return endpoint;
  }
  override async socket(kind: "native" | "rpc" | "lease", serverId?: string) {
    await this.verify();
    let name: string;
    if (kind === "rpc") {
      parseServerDescriptor({
        protocol: 1,
        serverId,
        pid: process.pid,
        endpoint: join(this.path, "r.sock"),
      });
      name = `r-${serverId!.replaceAll("-", "").slice(0, 16).toLowerCase()}.sock`;
    } else {
      if (kind !== "native" && kind !== "lease") fail();
      name = `${kind === "native" ? "n" : "l"}-${randomBytes(8).toString("hex")}.sock`;
    }
    const path = join(this.path, name);
    const endpoint = this.ownWindows(
      path,
      undefined,
      randomBytes(32).toString("hex"),
    );
    if (kind === "native") {
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      await endpoint.bind!(port);
    }
    return endpoint;
  }
  override async publishDescriptor(value: ManagerServerDescriptor) {
    const descriptor = parseServerDescriptor(value);
    await this.verify();
    this.withinWindows(descriptor.endpoint);
    if (
      basename(descriptor.endpoint) !==
      `r-${descriptor.serverId.replaceAll("-", "").slice(0, 16).toLowerCase()}.sock`
    )
      fail();
    const endpoint = this.entries.get(descriptor.endpoint)?.endpoint;
    if (!endpoint) fail();
    await endpoint!.secure();
    const path = join(this.path, `${descriptor.serverId}.json`);
    const file = await open(path, "wx");
    let identity: Stats;
    try {
      identity = await file.stat();
      await file.writeFile(JSON.stringify(descriptor) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    checkWindowsPrivatePath(path, false, true);
    return this.ownWindows(path, identity!);
  }
  override async readDescriptor(path: string) {
    await this.verify();
    this.withinWindows(path);
    checkWindowsPrivatePath(path);
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_FRAME_BYTES) fail();
    const data = await readFile(path);
    const after = await lstat(path);
    if (
      !same(before, after) ||
      after.size !== data.length ||
      data.length > MAX_FRAME_BYTES
    )
      fail();
    const descriptor = parseServerDescriptor(JSON.parse(data.toString()));
    if (basename(path) !== `${descriptor.serverId}.json`) fail();
    this.withinWindows(descriptor.endpoint);
    if (
      basename(descriptor.endpoint) !==
      `r-${descriptor.serverId.replaceAll("-", "").slice(0, 16).toLowerCase()}.sock`
    )
      fail();
    await readWindowsEndpoint(descriptor.endpoint);
    return descriptor;
  }
}
export async function openWindowsManagerDirectory(directory?: string) {
  if (process.platform !== "win32") fail();
  const path =
    directory ??
    join(process.env.LOCALAPPDATA ?? process.env.TEMP!, "gnw-manager");
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  checkWindowsPrivatePath(path, true);
  const info = await lstat(path);
  if (!info.isDirectory()) fail();
  return new WindowsManagerDirectory(path, info);
}
