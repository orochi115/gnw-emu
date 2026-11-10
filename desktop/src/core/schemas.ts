import { z } from "zod";
import { DOCK_CORNERS } from "../shared/dock-geometry";
const path = z
  .string()
  .min(1)
  .refine((s) => !/[\0\r\n]/.test(s), "Invalid path");
export const profileSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.uuid(),
    model: z.enum(["zelda", "mario"]),
    internalFlash: path,
    externalFlash: path,
    bank2Flash: path.optional(),
    sdCard: path.optional(),
    sdWiring: z.enum(["spi1", "ospi"]).optional(),
    deviceUid: z
      .string()
      .regex(/^[a-fA-F0-9]{24}$/)
      .optional(),
  })
  .strict()
  .refine((v) => !v.sdWiring || !!v.sdCard, {
    message: "sdWiring requires sdCard",
    path: ["sdCard"],
  });
export const sessionSchema = z
  .object({
    formatVersion: z.literal(1),
    battery: z.number().int().min(0).max(100).default(100),
    usbPower: z.boolean().default(false),
    rtc: z
      .string()
      .refine(
        (v) =>
          v === "host" ||
          (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v) &&
            Number.isFinite(Date.parse(v + "Z")) &&
            new Date(v + "Z").toISOString().slice(0, 19) === v),
        "Invalid RTC",
      )
      .default("host"),
    batteryLifeMinutes: z.number().int().nonnegative().default(480),
    chargeTimeMinutes: z.number().int().nonnegative().default(180),
  })
  .strict();
export const settingsSchema = z
  .object({
    formatVersion: z.literal(1),
    language: z.enum(["system", "zh-CN", "en"]).default("system"),
    showChassis: z.boolean().default(true),
    recentRoms: z.array(path).max(10).default([]),
    normalScale: z.number().finite().min(0.05).max(64).default(4),
    clockScale: z.number().finite().min(0.05).max(64).default(1),
    clockMode: z.boolean().default(false),
    clockDock: z.enum(DOCK_CORNERS).default("none"),
    clockBounds: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        displayId: z.number().int().optional(),
      })
      .strict()
      .optional(),
    audio: z.boolean().default(true),
    realtime: z.boolean().default(true),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const exitStateSchema = z
  .object({
    formatVersion: z.literal(1),
    battery: z.number().int().min(0).max(100),
    usbPower: z.boolean(),
  })
  .strict();
export type ProfileFields = Omit<
  z.infer<typeof profileSchema>,
  "formatVersion" | "id"
>;
export type Profile = z.infer<typeof profileSchema> & { path: string };
export type SessionState = z.infer<typeof sessionSchema>;
