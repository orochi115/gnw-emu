import { expect, test } from "vitest";
import { closeOwnedApplication } from "../e2e/helpers/owned-processes";

test("failed process discovery still closes the application and reaps only known owned native", async () => {
  const live = new Set([123, 456]);
  const killed: number[] = [];
  let closed = false;
  const evidence: Record<string, unknown> = {};
  await expect(
    closeOwnedApplication(
      {
        pid: 123,
        nativePids: new Set([456]),
        close: async () => {
          closed = true;
          live.delete(123);
        },
      },
      evidence,
      {
        descendants: () => {
          throw Error("injected ps failure");
        },
        alive: (pid) => live.has(pid),
        kill: (pid) => {
          killed.push(pid);
          live.delete(pid);
          return true;
        },
        wait: async () => {},
      },
    ),
  ).rejects.toThrow();
  expect(closed).toBe(true);
  expect(killed).toEqual([456]);
  expect(evidence.remainingNativePids).toEqual([]);
  expect(evidence.discoveryError).toContain("injected ps failure");
});

test("failed close still reaps captured descendants and reports the shutdown failure", async () => {
  const live = new Set([123, 456]);
  const evidence: Record<string, unknown> = {};
  await expect(
    closeOwnedApplication(
      {
        pid: 123,
        nativePids: new Set([456]),
        close: async () => {
          throw Error("injected close failure");
        },
      },
      evidence,
      {
        descendants: () => [123, 456],
        alive: (pid) => live.has(pid),
        kill: (pid) => {
          live.delete(pid);
          return true;
        },
        wait: async () => {},
      },
    ),
  ).rejects.toThrow("shutdown failed");
  expect(evidence.remainingOwnedPids).toEqual([]);
  expect(evidence.closeError).toContain("injected close failure");
});
