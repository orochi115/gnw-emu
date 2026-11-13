import { isAbsolute } from "node:path";
import { z } from "zod";

export const MANAGER_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 65536;
export const DEFAULT_LEASE_MS = 300000;
export const MAX_LEASE_MS = 3600000;
export const LEASE_IDLE_MS = 30000;
export const HEARTBEAT_MS = 10000;
export const MAX_CONNECTIONS = 16;
export const MAX_OUTSTANDING_REQUESTS = 8;
export const MANAGER_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "NOT_FOUND",
  "STALE_SESSION",
  "BUSY",
  "LEASE_EXPIRED",
  "NOT_OWNER",
  "NO_POWER",
  "UNCERTAIN",
  "TARGET_UNSAFE",
  "UNSUPPORTED",
  "INTERNAL",
] as const;
export type ManagerErrorCode = (typeof MANAGER_ERROR_CODES)[number];
export class ManagerProtocolError extends Error {
  constructor(
    readonly code: ManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagerProtocolError";
  }
}

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const requestId = z.string().min(1).max(128);
const ownerFields = { sessionId: uuid, leaseId: uuid };
const mutations = {
  managerUploaded: z.boolean(),
  memoryWritten: z.boolean(),
  executionChanged: z.boolean(),
};
const completionSchema = z
  .object({ success: z.boolean(), ...mutations })
  .strict();
const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("warm-reset") }).strict(),
  z.object({ action: z.literal("cold-start") }).strict(),
  z
    .object({
      action: z.literal("battery"),
      value: z.number().int().min(0).max(100),
    })
    .strict(),
  z
    .object({ action: z.literal("battery-present"), value: z.boolean() })
    .strict(),
  z.object({ action: z.literal("usb-power"), value: z.boolean() }).strict(),
  z
    .object({
      action: z.literal("press"),
      value: z
        .object({
          mask: z.number().int().min(0).max(4095),
          durationMs: z.number().int().min(1).max(30000),
        })
        .strict(),
    })
    .strict(),
]);
export type ManagerCompletion = z.infer<typeof completionSchema>;
export type ManagerMutations = Pick<ManagerCompletion, keyof typeof mutations>;
export type ManagerControl = z.infer<typeof controlSchema>;
export type ManagerOperation = "read" | "manage" | "debug";
export type ManagerExecution = "running" | "paused" | "unpowered" | "unknown";
export interface ManagerSessionDescriptor {
  sessionId: string;
  profileName: string;
  model: "mario" | "zelda";
  kernel: "gwemu";
  execution: ManagerExecution;
  powered: boolean;
  capabilities: string[];
}
const sessionSchema = z
  .object({
    sessionId: uuid,
    profileName: z.string().min(1).max(256),
    model: z.enum(["mario", "zelda"]),
    kernel: z.literal("gwemu"),
    execution: z.enum(["running", "paused", "unpowered", "unknown"]),
    powered: z.boolean(),
    capabilities: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();
const descriptorSchema = z
  .object({
    protocol: z.literal(1),
    serverId: uuid,
    pid: z.number().int().positive().max(2147483647),
    endpoint: z
      .string()
      .min(1)
      .refine(
        (value) =>
          isAbsolute(value) &&
          !value.includes("\0") &&
          Buffer.byteLength(value) <=
            (process.platform === "win32" ? 1024 : 100),
      ),
  })
  .strict();
export type ManagerServerDescriptor = z.infer<typeof descriptorSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ManagerProtocolError(
      "INVALID_REQUEST",
      "Invalid manager protocol data",
    );
  return result.data;
}
export function parseControl(value: unknown): ManagerControl {
  return parse(controlSchema, value);
}
export function parseCompletion(value: unknown): ManagerCompletion {
  return parse(completionSchema, value);
}
export function parseSessionDescriptor(
  value: unknown,
): ManagerSessionDescriptor {
  return parse(sessionSchema, value);
}
export function parseServerDescriptor(value: unknown): ManagerServerDescriptor {
  return parse(descriptorSchema, value);
}

const base = { protocol: z.literal(1), id: requestId };
const controlParams = z.union(
  controlSchema.options.map((schema) => schema.extend(ownerFields).strict()),
);
const requestSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...base,
      method: z.literal("hello"),
      params: z.object({ serverId: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("list"),
      params: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("acquire"),
      params: z
        .object({
          sessionId: uuid,
          operation: z.enum(["read", "manage", "debug"]),
          timeoutMs: z
            .number()
            .int()
            .min(1000)
            .max(MAX_LEASE_MS)
            .default(DEFAULT_LEASE_MS),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("heartbeat"),
      params: z.object(ownerFields).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("status"),
      params: z.object(ownerFields).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("mark"),
      params: z.object({ ...ownerFields, ...mutations }).strict(),
    })
    .strict(),
  z
    .object({ ...base, method: z.literal("control"), params: controlParams })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("release"),
      params: z
        .object({ ...ownerFields, completion: completionSchema })
        .strict(),
    })
    .strict(),
]);
export type ManagerRequest = z.infer<typeof requestSchema>;

/** Accept a complete NDJSON frame. Stream assembly/connection limits belong to the server. */
export function parseRequestFrame(frame: Buffer | string): ManagerRequest {
  const buffer = typeof frame === "string" ? Buffer.from(frame) : frame;
  if (
    !buffer.length ||
    buffer.length > MAX_FRAME_BYTES ||
    buffer.at(-1) !== 10 ||
    buffer.subarray(0, -1).includes(10)
  )
    throw new ManagerProtocolError("INVALID_REQUEST", "Invalid manager frame");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    );
  } catch {
    throw new ManagerProtocolError("INVALID_REQUEST", "Invalid manager JSON");
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "protocol" in value &&
    typeof value.protocol === "number" &&
    value.protocol !== MANAGER_PROTOCOL
  )
    throw new ManagerProtocolError(
      "UNSUPPORTED_VERSION",
      "Unsupported manager protocol version",
    );
  return parse(requestSchema, value);
}

export type ManagerResponse =
  | { protocol: 1; id: string; ok: true; result: Record<string, unknown> }
  | {
      protocol: 1;
      id: string;
      ok: false;
      error: { code: ManagerErrorCode; message: string };
    };
const responseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ...base,
      ok: z.literal(true),
      result: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      ...base,
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(MANAGER_ERROR_CODES),
          message: z.string().min(1).max(1024),
        })
        .strict(),
    })
    .strict(),
]);
export function encodeResponse(value: ManagerResponse): Buffer {
  const response = parse(responseSchema, value);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(JSON.stringify(response) + "\n");
  } catch {
    throw new ManagerProtocolError(
      "INVALID_REQUEST",
      "Unserializable manager response",
    );
  }
  if (buffer.length > MAX_FRAME_BYTES)
    throw new ManagerProtocolError(
      "INVALID_REQUEST",
      "Manager response exceeds size limit",
    );
  return buffer;
}
