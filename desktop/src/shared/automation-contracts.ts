import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9.:-]+$/);
const level = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);
const empty = z.object({}).strict();
const deviceMenuIds = [
  "device.batteryDown",
  "device.batteryUp",
  "device.batteryPresent",
  "device.usb",
  "device.pause",
  "device.resume",
  "device.coldStart",
] as const;
const schemas: Record<string, z.ZodType> = {
  "ui.inspect": empty,
  "app.getState": empty,
  "app.getDiagnostics": empty,
  "automation.capabilities": empty,
  "logging.getConfig": empty,
  "ui.contextMenu": z
    .object({
      id: z.enum([
        ...deviceMenuIds,
        "view.clock",
        "view.chassis",
        "audio.mute",
        "app.quit",
        "clock.dock.none",
        "clock.dock.topLeft",
        "clock.dock.topRight",
        "clock.dock.bottomLeft",
        "clock.dock.bottomRight",
        "view.scale.half",
        "view.scale.1",
        "view.scale.2",
        "view.scale.3",
        "view.scale.4",
        "view.scale.5",
        "view.scale.6",
      ]),
    })
    .strict(),
  "ui.menu": z
    .object({
      id: z.enum([
        ...deviceMenuIds,
        "file.open",
        "file.make",
        "controls.open",
        "controls.hotkeys",
        "audio.mute",
        "file.recent.0",
        "file.recent.1",
        "file.recent.2",
        "file.recent.3",
        "file.recent.4",
        "file.recent.5",
        "file.recent.6",
        "file.recent.7",
        "file.recent.8",
        "file.recent.9",
        "file.recent.clear",
        "view.chassis",
        "view.clock",
        "view.scale.half",
        "view.scale.1",
        "view.scale.2",
        "view.scale.3",
        "view.scale.4",
        "view.scale.5",
        "view.scale.6",
        "app.quit",
        "edit.undo",
        "edit.redo",
        "edit.cut",
        "edit.copy",
        "edit.paste",
        "edit.selectAll",
        "window.minimize",
        "window.zoom",
        "window.front",
        "window.close",
      ]),
    })
    .strict(),
  "ui.click": z.object({ id }).strict(),
  "ui.fill": z.object({ id, value: z.string().max(8192) }).strict(),
  "ui.select": z.object({ id, value: z.string().max(128) }).strict(),
  "ui.key": z
    .object({ key: z.string().min(1).max(32), down: z.boolean().optional() })
    .strict(),
  "ui.pointer": z
    .object({
      id: id.optional(),
      phase: z.enum(["down", "up"]),
      x: z.number().int().min(0).max(10000).optional(),
      y: z.number().int().min(0).max(10000).optional(),
    })
    .strict()
    .refine(
      (v) =>
        !!v.id || (v.phase === "up" && v.x !== undefined && v.y !== undefined),
      "Expected a control or release coordinates",
    ),
  "ui.screenshot": z
    .object({
      path: z
        .string()
        .max(8192)
        .regex(/\.png$/)
        .refine((v) => !v.includes("\0")),
    })
    .strict(),
  "ui.waitFor": z
    .object({
      condition: z.enum(["app.status", "ui.dialogOpen", "ui.lastPresented"]),
      value: z.union([
        z.string().max(64),
        z.boolean(),
        z.number().int().nonnegative(),
      ]),
      timeoutMs: z.number().int().min(1).max(60000).optional(),
      waitId: z.string().max(128).optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.condition !== "ui.lastPresented" || /^\d+$/.test(String(v.value)),
      "Expected decimal frame sequence",
    ),
  "automation.getOperation": z.object({ operationId: z.uuid() }).strict(),
  "automation.cancelWait": z
    .object({ waitId: z.string().min(1).max(128) })
    .strict(),
  "automation.queueDialogResponse": z
    .object({
      kind: z.enum(["open", "save"]),
      path: z.string().max(8192).nullable(),
    })
    .strict(),
  "logging.configure": z
    .object({
      level: level.optional(),
      modules: z.record(z.string().min(1).max(64), level).optional(),
    })
    .strict(),
  "logging.tail": z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
      after: z.number().int().nonnegative().optional(),
      module: z.string().max(64).optional(),
      level: z.number().int().min(10).max(60).optional(),
    })
    .strict(),
};
export const METHODS = Object.keys(schemas);
export function validateAutomationParams(
  method: string,
  input: unknown,
): Record<string, any> {
  const { runtimeSessionId, ...params } = z
    .object({ runtimeSessionId: z.uuid().optional() })
    .passthrough()
    .parse(input);
  const schema = schemas[method];
  if (!schema) throw new Error("Unknown method");
  return {
    ...(schema.parse(params) as Record<string, unknown>),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
  };
}
