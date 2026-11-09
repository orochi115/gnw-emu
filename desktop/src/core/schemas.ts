import { z } from "zod";
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
    audio: z.boolean().default(true),
    realtime: z.boolean().default(true),
  })
  .strict();
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
