import { expect, test, vi } from "vitest";
import { MemoryMonitor } from "../../src/core/memory-monitor";
test("memory growth warnings are rate limited and reset for a new session", async () => {
  vi.useFakeTimers();
  try {
    let id = "a",
      privateBytes = 1024 ** 3;
    const log = vi.fn();
    const monitor = new MemoryMonitor({
      sample: async () => ({ id, privateBytes }),
      log,
    });
    await monitor.tick();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    privateBytes *= 1.3;
    await monitor.tick();
    await monitor.tick();
    expect(log.mock.calls.filter((c) => c[0] === "memory.growth")).toHaveLength(
      1,
    );
    id = "b";
    await monitor.tick();
    expect(log.mock.calls.filter((c) => c[0] === "memory.growth")).toHaveLength(
      1,
    );
    monitor.dispose();
    const count = log.mock.calls.length;
    await monitor.tick();
    expect(log).toHaveBeenCalledTimes(count);
  } finally {
    vi.useRealTimers();
  }
});
test("sampling failures do not stop the application", async () => {
  const log = vi.fn();
  const monitor = new MemoryMonitor({
    sample: async () => {
      throw Error("sample failed");
    },
    log,
  });
  await monitor.tick();
  expect(log.mock.calls[0][0]).toBe("memory.sample.failed");
  monitor.dispose();
});
