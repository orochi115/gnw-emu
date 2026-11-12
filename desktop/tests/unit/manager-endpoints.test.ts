import { expect, test, vi } from "vitest";
import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  open,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { openManagerDirectory } from "../../src/core/manager-endpoints";

const serverId = "550e8400-e29b-41d4-a716-446655440000";
async function sandbox() {
  return mkdtemp("/tmp/gnw-manager-test-");
}
async function listen(path: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}
async function close(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("creates one private directory and refuses unsafe mode, owner and symlink", async () => {
  const root = await sandbox();
  try {
    const directory = join(root, "private");
    expect((await openManagerDirectory({ directory })).path).toBe(directory);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    await expect(
      openManagerDirectory({ directory, uid: process.getuid!() + 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await chmod(directory, 0o755);
    await expect(openManagerDirectory({ directory })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    await symlink(directory, join(root, "link"));
    await expect(
      openManagerDirectory({ directory: join(root, "link") }),
    ).rejects.toThrow();
    await writeFile(join(root, "file"), "peer");
    await expect(
      openManagerDirectory({ directory: join(root, "file") }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allocates short socket paths, secures real sockets, and writes exclusive private descriptors", async () => {
  const root = await sandbox();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const directory = await openManagerDirectory({ directory: root });
    const rpc = await directory.socket("rpc", serverId);
    expect(rpc.path).toBe(join(root, "r-550e8400e29b41d4.sock"));
    server = await listen(rpc.path);
    await rpc.secure();
    expect((await lstat(rpc.path)).mode & 0o777).toBe(0o600);
    const descriptor = await directory.publishDescriptor({
      protocol: 1,
      serverId,
      pid: process.pid,
      endpoint: rpc.path,
    });
    expect((await lstat(descriptor.path)).mode & 0o777).toBe(0o600);
    expect(await directory.readDescriptor(descriptor.path)).toMatchObject({
      serverId,
      endpoint: rpc.path,
    });
    await expect(
      directory.publishDescriptor({
        protocol: 1,
        serverId,
        pid: process.pid,
        endpoint: rpc.path,
      }),
    ).rejects.toThrow();
    const peer = join(root, "peer.json");
    await writeFile(peer, "peer");
    await descriptor.close();
    await rpc.close();
    await rpc.close();
    expect(await readFile(peer, "utf8")).toBe("peer");
    await expect(lstat(descriptor.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent RPC allocation retains one owner that can secure and clean up its socket", async () => {
  const root = await sandbox();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const directory = await openManagerDirectory({ directory: root });
    const results = await Promise.allSettled([
      directory.socket("rpc", serverId),
      directory.socket("rpc", serverId),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ code: "UNSUPPORTED" });
    const rpc = winners[0].value;
    server = await listen(rpc.path);
    await rpc.secure();
    expect((await lstat(rpc.path)).mode & 0o777).toBe(0o600);
    const peer = join(root, "peer.json");
    await writeFile(peer, "peer");
    await rpc.close();
    // Check before closing the server so Node's own cleanup cannot mask a leak.
    await expect(lstat(rpc.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(peer, "utf8")).toBe("peer");
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("owned cleanup preserves replacements, and never removes unclaimed paths", async () => {
  const root = await sandbox();
  try {
    const directory = await openManagerDirectory({ directory: root });
    const native = await directory.socket("native");
    await writeFile(native.path, "peer", { mode: 0o600 });
    await expect(native.secure()).rejects.toThrow();
    await native.close();
    expect(await readFile(native.path, "utf8")).toBe("peer");
    const rpc = await directory.socket("rpc", serverId);
    const server = await listen(rpc.path);
    await rpc.secure();
    const descriptor = await directory.publishDescriptor({
      protocol: 1,
      serverId,
      pid: process.pid,
      endpoint: rpc.path,
    });
    await rm(descriptor.path);
    await writeFile(descriptor.path, "replacement", { mode: 0o600 });
    await descriptor.close();
    expect(await readFile(descriptor.path, "utf8")).toBe("replacement");
    await rpc.close();
    await close(server);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor discovery rejects wrong boundary, name, mode and symlinks", async () => {
  const root = await sandbox();
  try {
    const directory = await openManagerDirectory({ directory: root });
    const path = join(root, `${serverId}.json`);
    const descriptor = {
      protocol: 1,
      serverId,
      pid: process.pid,
      endpoint: join(root, "r-550e8400e29b41d4.sock"),
    };
    const rpc = await directory.socket("rpc", serverId);
    const server = await listen(rpc.path);
    await rpc.secure();
    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
    expect(await directory.readDescriptor(path)).toEqual(descriptor);
    await chmod(path, 0o644);
    await expect(directory.readDescriptor(path)).rejects.toThrow();
    await chmod(path, 0o600);
    await writeFile(
      path,
      JSON.stringify({
        ...descriptor,
        endpoint: join(root, "..", "peer.sock"),
      }),
    );
    await expect(directory.readDescriptor(path)).rejects.toThrow();
    await rm(path);
    await symlink(join(root, "missing"), path);
    await expect(directory.readDescriptor(path)).rejects.toThrow();
    await rpc.close();
    await close(server);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported platforms and overlong Unix paths fail with no TCP fallback", async () => {
  await expect(
    openManagerDirectory({ platform: "win32" }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const root = await sandbox();
  try {
    const long = join(root, "好".repeat(30));
    await mkdir(long, { mode: 0o700 });
    const directory = await openManagerDirectory({ directory: long });
    await expect(directory.socket("lease")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory identity is rechecked before mutating or deleting resources", async () => {
  const root = await sandbox();
  try {
    const directory = await openManagerDirectory({ directory: root });
    await chmod(root, 0o755);
    await expect(directory.socket("native")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing a private directory does not let an old handle claim new resources", async () => {
  const root = await sandbox();
  const old = `${root}-old`;
  try {
    const directory = await openManagerDirectory({ directory: root });
    await rename(root, old);
    await mkdir(root, { mode: 0o700 });
    await expect(directory.socket("native")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
});

test("descriptor reader handles actual short filesystem reads without truncating JSON", async () => {
  const root = await sandbox();
  let server: ReturnType<typeof createServer> | undefined;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const directory = await openManagerDirectory({ directory: root });
    const rpc = await directory.socket("rpc", serverId);
    server = await listen(rpc.path);
    await rpc.secure();
    const descriptor = {
      protocol: 1 as const,
      serverId,
      pid: process.pid,
      endpoint: rpc.path,
    };
    const publication = await directory.publishDescriptor(descriptor);
    const handle = await open(publication.path, "r");
    const prototype = Object.getPrototypeOf(handle);
    const real = prototype.read;
    await handle.close();
    spy = vi.spyOn(prototype, "read").mockImplementation(function (
      this: unknown,
      buffer: unknown,
      offset: unknown,
      length: unknown,
      position: unknown,
    ) {
      return real.call(
        this,
        buffer,
        offset,
        Math.min(Number(length), 23),
        position,
      );
    });
    expect(await directory.readDescriptor(publication.path)).toEqual(
      descriptor,
    );
    await publication.close();
    await rpc.close();
  } finally {
    spy?.mockRestore();
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
