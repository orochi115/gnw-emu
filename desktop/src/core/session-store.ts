import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type Profile,
  type SessionState,
  sessionSchema,
  gwemuSessionSchema,
  gwemuPowerSnapshotSchema,
} from "./schemas";
import { readJson, writeJson } from "./atomic-file";
export interface Session extends SessionState {
  batteryPresent?: boolean;
  directory: string;
  internalFlash: string;
  externalFlash: string;
  bank2Flash?: string;
  sdCard?: string;
}
export async function prepareSession(
  profile: Profile,
  userData: string,
  kernel: "legacy" | "gwemu" = "legacy",
): Promise<Session> {
  const directory = join(userData, "sessions", profile.id);
  const file = join(directory, "session.json");
  const schema = kernel === "gwemu" ? gwemuSessionSchema : sessionSchema;
  let state: SessionState & { batteryPresent?: boolean };
  try {
    state = schema.parse(await readJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Stage the entire new session. A failed copy never exposes a valid half-session.
    const staging = `${directory}.${randomUUID()}.tmp`;
    await mkdir(staging, { recursive: true });
    try {
      for (const [key, name] of [
        ["internalFlash", "bank1.bin"],
        ["externalFlash", "flash.bin"],
        ["bank2Flash", "bank2.bin"],
        ["sdCard", "sdcard.img"],
      ] as const)
        if (profile[key])
          await copyFile(
            profile[key]!,
            join(staging, name),
            constants.COPYFILE_EXCL,
          );
      state = schema.parse({ formatVersion: 1 });
      await writeJson(join(staging, "session.json"), state);
      await rename(staging, directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return {
    ...state,
    directory,
    internalFlash: join(directory, "bank1.bin"),
    externalFlash: join(directory, "flash.bin"),
    ...(profile.bank2Flash ? { bank2Flash: join(directory, "bank2.bin") } : {}),
    ...(profile.sdCard ? { sdCard: join(directory, "sdcard.img") } : {}),
  };
}
export async function saveSession(
  session: Session,
  snapshot: { battery: number; usbPower: boolean; batteryPresent?: boolean },
  kernel: "legacy" | "gwemu" = "legacy",
) {
  const {
    formatVersion,
    battery,
    usbPower,
    rtc,
    batteryLifeMinutes,
    chargeTimeMinutes,
  } = session;
  const power =
    kernel === "gwemu" ? gwemuPowerSnapshotSchema.parse(snapshot) : snapshot;
  const schema = kernel === "gwemu" ? gwemuSessionSchema : sessionSchema;
  const state = schema.parse({
    formatVersion,
    rtc,
    batteryLifeMinutes,
    chargeTimeMinutes,
    ...power,
  });
  await writeJson(join(session.directory, "session.json"), state);
  Object.assign(session, state);
}
