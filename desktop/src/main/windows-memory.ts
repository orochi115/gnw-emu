import { createRequire } from "node:module";
let api: ReturnType<typeof loadApi> | undefined;
function loadApi() {
  const koffi: typeof import("koffi") = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll"),
    psapi = koffi.load("psapi.dll");
  return {
    open: kernel.func(
      "void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)",
    ),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    memory: psapi.func(
      "int __stdcall GetProcessMemoryInfo(void *handle, void *info, uint32 size)",
    ),
    handles: kernel.func(
      "int __stdcall GetProcessHandleCount(void *handle, void *count)",
    ),
    performance: psapi.func(
      "int __stdcall GetPerformanceInfo(void *info, uint32 size)",
    ),
  };
}
export function windowsMemory(pid?: number) {
  const native = (api ??= loadApi());
  const result: Record<string, number> = {};
  const system = Buffer.alloc(104);
  system.writeUInt32LE(system.length);
  if (native.performance(system, system.length)) {
    const page = Number(system.readBigUInt64LE(80));
    result.systemCommitBytes = Number(system.readBigUInt64LE(8)) * page;
    result.systemCommitLimitBytes = Number(system.readBigUInt64LE(16)) * page;
    result.systemAvailableBytes = Number(system.readBigUInt64LE(40)) * page;
  }
  if (pid) {
    const handle = native.open(0x410, 0, pid);
    if (!handle) return result; // Process may have exited during sampling.
    try {
      const info = Buffer.alloc(80);
      info.writeUInt32LE(info.length);
      if (!native.memory(handle, info, info.length))
        throw Error("GetProcessMemoryInfo failed");
      result.privateBytes = Number(info.readBigUInt64LE(72));
      result.workingSetBytes = Number(info.readBigUInt64LE(16));
      const count = Buffer.alloc(4);
      if (native.handles(handle, count))
        result.handleCount = count.readUInt32LE();
    } finally {
      native.close(handle);
    }
  }
  return result;
}
