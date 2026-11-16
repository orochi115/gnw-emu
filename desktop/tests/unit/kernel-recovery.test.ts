import { afterEach, expect, test, vi } from "vitest";
import { KernelRecovery } from "../../src/core/kernel-recovery";
import { UserError } from "../../src/shared/user-error";
afterEach(() => vi.useRealTimers());
test("retries recoverable startup failures with a finite budget and keeps the same profile", async () => {
  vi.useFakeTimers();
  const starts: string[] = [],
    logs: string[] = [];
  const recovery = new KernelRecovery({
    start: async (path) => {
      starts.push(path);
      if (starts.length < 3) throw new UserError("error.kernelConnection");
    },
    stop: async () => {},
    log: (event) => logs.push(event),
  });
  const load = recovery.load("/game.gnw.json");
  await vi.runAllTimersAsync();
  await load;
  expect(starts).toEqual([
    "/game.gnw.json",
    "/game.gnw.json",
    "/game.gnw.json",
  ]);
  expect(logs).toContain("recovery.succeeded");
  recovery.dispose();
});
test("persistent native failures stop after three automatic retries", async () => {
  vi.useFakeTimers();
  let starts = 0;
  const recovery = new KernelRecovery({
    start: async () => {
      starts++;
      throw new UserError("error.kernelConnection");
    },
    stop: async () => {},
    log: () => {},
  });
  const load = recovery.load("/game.gnw.json");
  const failure = expect(load).rejects.toThrow("error.kernelConnection");
  await vi.runAllTimersAsync();
  await failure;
  expect(starts).toBe(4);
  recovery.dispose();
});
test("missing firmware and incompatible native features are not retried", async () => {
  vi.useFakeTimers();
  let starts = 0;
  const recovery = new KernelRecovery({
    start: async () => {
      starts++;
      throw new UserError("error.kernelBuild");
    },
    stop: async () => {},
    log: () => {},
  });
  await expect(recovery.load("/game.gnw.json")).rejects.toThrow(
    "error.kernelBuild",
  );
  await vi.runAllTimersAsync();
  expect(starts).toBe(1);
  recovery.dispose();
});
test("quit cancels a pending restart and awaits owned startup shutdown", async () => {
  vi.useFakeTimers();
  let starts = 0,
    stops = 0;
  const recovery = new KernelRecovery({
    start: async () => {
      starts++;
      throw new UserError("error.kernelConnection");
    },
    stop: async () => {
      stops++;
    },
    log: () => {},
  });
  const load = recovery.load("/game.gnw.json");
  const cancelled = expect(load).rejects.toThrow("error.startCancelled");
  await Promise.resolve();
  await Promise.resolve();
  await recovery.stop();
  await vi.runAllTimersAsync();
  await cancelled;
  expect(starts).toBe(1);
  expect(stops).toBeGreaterThan(0);
});
test("duplicate transport/process failures share a restart and the rolling budget persists", async () => {
  vi.useFakeTimers();
  let starts = 0;
  const recovery = new KernelRecovery({
    start: async () => {
      starts++;
    },
    stop: async () => {},
    log: () => {},
  });
  await recovery.load("/mario.gnw.json");
  for (let i = 0; i < 3; i++) {
    const a = recovery.recover(new UserError("error.exited"), "old");
    const b = recovery.recover(
      new UserError("error.controlDisconnected"),
      "old",
    );
    expect(a).toBe(b);
    await vi.runAllTimersAsync();
    await a;
  }
  await expect(recovery.recover(new UserError("error.exited"))).rejects.toThrow(
    "error.exited",
  );
  expect(starts).toBe(4);
  recovery.dispose();
});
test("replacing a profile cancels its pending recovery", async () => {
  vi.useFakeTimers();
  const starts: string[] = [];
  const recovery = new KernelRecovery({
    start: async (path) => {
      starts.push(path);
      if (path === "old") throw new UserError("error.exited");
    },
    stop: async () => {},
    log: () => {},
  });
  const old = recovery.load("old");
  const rejected = expect(old).rejects.toThrow("error.startCancelled");
  await Promise.resolve();
  await Promise.resolve();
  await recovery.load("new");
  await rejected;
  await vi.runAllTimersAsync();
  expect(starts).toEqual(["old", "new"]);
  recovery.dispose();
});
