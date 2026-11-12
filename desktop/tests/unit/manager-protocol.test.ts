import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseRequestFrame,
  parseControl,
  parseCompletion,
  encodeResponse,
  parseServerDescriptor,
  parseSessionDescriptor,
  MAX_FRAME_BYTES,
} from "../../src/core/manager-protocol";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const leaseId = "550e8400-e29b-41d4-a716-446655440001";
const frame = (method: string, params: unknown = {}) =>
  Buffer.from(
    JSON.stringify({ protocol: 1, id: "request-1", method, params }) + "\n",
  );

test("shared protocol fixture accepts exact requests and rejects invalid cases", async () => {
  const fixture = JSON.parse(
    await readFile(
      resolve("../tests/fixtures/manager-session-protocol.json"),
      "utf8",
    ),
  );
  for (const request of fixture.validRequests)
    expect(
      parseRequestFrame(Buffer.from(JSON.stringify(request) + "\n")),
    ).toMatchObject(request);
  for (const { request, code } of fixture.invalidRequests)
    expect(() =>
      parseRequestFrame(Buffer.from(JSON.stringify(request) + "\n")),
    ).toThrowError(expect.objectContaining({ code }));
});

test("acquire normalizes a bounded fixed total lease budget", () => {
  expect(
    parseRequestFrame(frame("acquire", { sessionId, operation: "read" }))
      .params,
  ).toEqual({
    sessionId,
    operation: "read",
    timeoutMs: 300000,
  });
  for (const timeoutMs of [999, 3600001, 1.5, true])
    expect(() =>
      parseRequestFrame(
        frame("acquire", { sessionId, operation: "manage", timeoutMs }),
      ),
    ).toThrow();
});

test("NDJSON checks actual bytes including the terminator and fatal UTF-8", () => {
  const request = frame("list");
  const padding = MAX_FRAME_BYTES - request.length;
  const exact = Buffer.concat([Buffer.alloc(padding, 32), request]);
  expect(exact.length).toBe(MAX_FRAME_BYTES);
  expect(parseRequestFrame(exact).method).toBe("list");
  expect(() =>
    parseRequestFrame(Buffer.concat([Buffer.from(" "), exact])),
  ).toThrow();
  expect(() => parseRequestFrame(request.subarray(0, -1))).toThrow();
  expect(() => parseRequestFrame(Buffer.concat([request, request]))).toThrow();
  expect(() => parseRequestFrame(Buffer.from([0xff, 0x0a]))).toThrow();
  const unicode =
    JSON.stringify({
      protocol: 1,
      id: "好".repeat(128),
      method: "list",
      params: {},
    }) + "\n";
  expect(parseRequestFrame(unicode).id).toHaveLength(128);
});

test("control preserves product POWER bit9 and bounds twelve-bit combinations", () => {
  expect(
    parseControl({
      action: "press",
      value: { mask: 1 << 9, durationMs: 30000 },
    }),
  ).toEqual({
    action: "press",
    value: { mask: 512, durationMs: 30000 },
  });
  expect(
    parseControl({ action: "press", value: { mask: 4095, durationMs: 1 } }),
  ).toBeDefined();
  for (const value of [
    { mask: 4096, durationMs: 1 },
    { mask: -1, durationMs: 1 },
    { mask: 512, durationMs: 0 },
    { mask: 512, durationMs: 30001 },
    { mask: true, durationMs: 1 },
  ])
    expect(() => parseControl({ action: "press", value })).toThrow();
  for (const control of [
    { action: "pause", value: false },
    { action: "qom-set", value: 1 },
    { action: "battery", value: 1.5 },
    { action: "battery-present", value: 1 },
    { action: "usb-power", value: "on" },
    { action: "screenshot", value: "/tmp/output.png" },
  ])
    expect(() => parseControl(control)).toThrow();
  expect(
    parseRequestFrame(
      frame("control", {
        sessionId,
        leaseId,
        action: "usb-power",
        value: false,
      }),
    ).params,
  ).toMatchObject({ value: false });
});

test("mutation/release requires all booleans and rejects extra or partial fields", () => {
  const changes = {
    managerUploaded: true,
    memoryWritten: false,
    executionChanged: true,
  };
  expect(
    parseRequestFrame(frame("mark", { sessionId, leaseId, ...changes })).method,
  ).toBe("mark");
  const completion = { success: true, ...changes };
  expect(parseCompletion(completion)).toEqual(completion);
  for (const value of [
    { success: true },
    { ...completion, success: 1 },
    { ...completion, resume: true },
  ])
    expect(() => parseCompletion(value)).toThrow();
  expect(() =>
    parseRequestFrame(
      frame("release", { sessionId, leaseId, completion: changes }),
    ),
  ).toThrow();
});

test("lease methods require exact UUID owners and session summaries carry no image paths", () => {
  expect(
    parseRequestFrame(frame("status", { sessionId, leaseId })).method,
  ).toBe("status");
  for (const method of ["status", "heartbeat"])
    for (const params of [
      { sessionId },
      { sessionId, leaseId: "bad" },
      { sessionId, leaseId, path: "/tmp/source" },
    ])
      expect(() => parseRequestFrame(frame(method, params))).toThrow();
  const session = {
    sessionId,
    profileName: "Mario",
    model: "mario",
    kernel: "gwemu",
    execution: "running",
    powered: true,
    capabilities: ["manage", "gdb", "backup", "device-control"],
  };
  expect(parseSessionDescriptor(session)).toEqual(session);
  for (const value of [
    { ...session, kernel: "legacy" },
    { ...session, model: "unknown" },
    { ...session, sourceImage: "/tmp/source.bin" },
    { ...session, powered: 1 },
  ])
    expect(() => parseSessionDescriptor(value)).toThrow();
});

test("descriptor and response shapes are exact and encoded replies stay bounded", () => {
  const descriptor = {
    protocol: 1,
    serverId: sessionId,
    pid: 123,
    endpoint: "/tmp/gnw-manager-501/r-550e8400e29b41d4.sock",
  };
  expect(parseServerDescriptor(descriptor)).toEqual(descriptor);
  for (const value of [
    { ...descriptor, sourceImage: "/private/source.bin" },
    { ...descriptor, pid: true },
    { ...descriptor, endpoint: "relative.sock" },
    { ...descriptor, serverId: "bad" },
  ])
    expect(() => parseServerDescriptor(value)).toThrow();
  const response = {
    protocol: 1 as const,
    id: "one",
    ok: false as const,
    error: { code: "BUSY" as const, message: "Device is busy" },
  };
  expect(JSON.parse(encodeResponse(response).toString())).toEqual(response);
  expect(() =>
    encodeResponse({
      ...response,
      error: { code: "BAD" as any, message: "no" },
    }),
  ).toThrow();
  expect(() =>
    encodeResponse({
      protocol: 1,
      id: "one",
      ok: true,
      result: { text: "x".repeat(MAX_FRAME_BYTES) },
    }),
  ).toThrow();
});
