/** Windows transports use authenticated loopback streams. Credentials live only
 * in a directory whose protected DACL grants the current user and SYSTEM. */
import {
  createConnection,
  createServer,
  type Socket,
  type Server,
} from "node:net";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ManagerProtocolError } from "./manager-protocol";

export const windowsAclScript = String.raw`
$ErrorActionPreference='Stop'
$p=$env:GNW_PRIVATE_PATH
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:GNW_PRIVATE_CREATE -eq '1' -and !(Test-Path -LiteralPath $p)) {
  [System.IO.Directory]::CreateDirectory($p) | Out-Null
  $acl=New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($id in @($sid, [System.Security.Principal.SecurityIdentifier]'S-1-5-18')) {
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $p -AclObject $acl
}
$item=Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Reparse points are not private manager resources'}
$acl=Get-Acl -LiteralPath $p
if($env:GNW_PRIVATE_OWN -eq '1') { $acl.SetOwner($sid); Set-Acl -LiteralPath $p -AclObject $acl; $acl=Get-Acl -LiteralPath $p }
if($acl.Owner -ne $sid.Value -and ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {throw 'Manager path owner differs'}
foreach($rule in $acl.Access) {
  $id=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if($rule.AccessControlType -eq 'Allow' -and $id -ne $sid.Value -and $id -ne 'S-1-5-18') {throw 'Manager path has a foreign access grant'}
}
`;
export function checkWindowsPrivatePath(
  path: string,
  create = false,
  ownCreated = false,
) {
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsAclScript, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          GNW_PRIVATE_PATH: path,
          GNW_PRIVATE_CREATE: create ? "1" : "0",
          GNW_PRIVATE_OWN: ownCreated ? "1" : "0",
        },
        windowsHide: true,
        stdio: "pipe",
        timeout: 10000,
      },
    );
  } catch {
    throw new ManagerProtocolError(
      "UNSUPPORTED",
      "Windows manager path is not private to the current user",
    );
  }
}
export interface WindowsEndpointCredential {
  format: 1;
  port: number;
  token: string;
  pid: number;
}
export async function readWindowsEndpoint(
  path: string,
): Promise<WindowsEndpointCredential> {
  checkWindowsPrivatePath(path);
  const data = await readFile(path);
  if (data.length > 1024)
    throw new ManagerProtocolError(
      "INVALID_REQUEST",
      "Oversized Windows manager endpoint",
    );
  const value = JSON.parse(data.toString());
  if (
    Object.keys(value).sort().join() !== "format,pid,port,token" ||
    value.format !== 1 ||
    !Number.isInteger(value.pid) ||
    value.pid < 1 ||
    value.pid > 2147483647 ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(value.token)
  )
    throw new ManagerProtocolError(
      "INVALID_REQUEST",
      "Invalid Windows manager endpoint",
    );
  return value;
}
export async function connectManagerEndpoint(path: string): Promise<Socket> {
  if (process.platform !== "win32") return createConnection({ path });
  const credential = await readWindowsEndpoint(path);
  const rows = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  }).split(/\r?\n/);
  if (
    !rows.some((row) => {
      const parts = row.trim().split(/\s+/);
      return (
        parts[0] === "TCP" &&
        parts[1] === `127.0.0.1:${credential.port}` &&
        parts[3] === "LISTENING" &&
        Number(parts[4]) === credential.pid
      );
    })
  )
    throw new ManagerProtocolError(
      "STALE_SESSION",
      "Windows manager listener no longer belongs to its owning process",
    );
  const socket = createConnection({ host: "127.0.0.1", port: credential.port });
  socket.once("connect", () => socket.write(credential.token));
  return socket;
}
export async function listenAuthenticatedLoopback(
  token: string,
  accept: (socket: Socket) => void,
): Promise<Server> {
  const expected = Buffer.from(token);
  if (expected.length !== 64 || !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid transport credential");
  const peers = new Set<Socket>();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.on("error", () => socket.destroy());
    if (peers.size > 32) {
      socket.destroy();
      return;
    }
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.once("close", () => clearTimeout(timer));
    let buffer = Buffer.alloc(0);
    const authenticate = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 64) return;
      clearTimeout(timer);
      socket.removeListener("data", authenticate);
      if (!timingSafeEqual(buffer.subarray(0, 64), expected)) {
        socket.destroy();
        return;
      }
      socket.pause();
      const rest = buffer.subarray(64);
      if (rest.length) socket.unshift(rest);
      accept(socket);
      socket.resume();
    };
    socket.on("data", authenticate);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // Retiring the listener also rejects clients which have not authenticated.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const peer of peers) peer.destroy();
    return close(callback);
  }) as typeof server.close;
  return server;
}
