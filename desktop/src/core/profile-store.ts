import { UserError } from "../shared/user-error";
import { stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { profileSchema, type Profile, type ProfileFields } from "./schemas";
import { readJson, writeJson } from "./atomic-file";
const imageFields = [
  "internalFlash",
  "externalFlash",
  "bank2Flash",
  "sdCard",
] as const;
export async function validateImages(profile: Profile) {
  for (const key of imageFields) {
    const path = profile[key];
    if (!path) continue;
    const file = await stat(path).catch(() => {
      throw new UserError("error.imageRead", { field: key, path });
    });
    const limit =
      key === "bank2Flash"
        ? 256 * 1024
        : key === "internalFlash"
          ? 1024 * 1024
          : key === "externalFlash"
            ? 256 * 1024 * 1024
            : Number.MAX_SAFE_INTEGER;
    if (!file.isFile() || !file.size || file.size > limit)
      throw new UserError("error.imageSize", { field: key });
  }
}
export async function loadProfile(path: string): Promise<Profile> {
  if (!path.endsWith(".gnw.json"))
    throw new UserError("error.profileExtension");
  const data = profileSchema.parse(await readJson(path));
  const profile: Profile = { ...data, path: resolve(path) };
  for (const key of imageFields)
    if (profile[key])
      profile[key] = resolve(dirname(profile.path), profile[key]!);
  await validateImages(profile);
  return profile;
}
export async function createProfile(
  path: string,
  fields: ProfileFields,
): Promise<Profile> {
  if (!path.endsWith(".gnw.json"))
    throw new UserError("error.profileExtension");
  const data = profileSchema.parse({
    ...fields,
    formatVersion: 1,
    id: randomUUID(),
  });
  const profile: Profile = { ...data, path: resolve(path) };
  for (const key of imageFields)
    if (profile[key]) profile[key] = resolve(profile[key]!);
  await validateImages(profile);
  const stored = { ...data };
  for (const key of imageFields)
    if (profile[key])
      stored[key] = relative(dirname(profile.path), profile[key]!)
        .split("\\")
        .join("/");
  await writeJson(profile.path, stored);
  return profile;
}

/** Shell launchers preserve a JSON identity only for an unchanged configuration.
 * Fresh explicitly creates a new identity; existing saves are never deleted. */
export async function ensureProfile(
  path: string,
  fields: ProfileFields,
  fresh = false,
): Promise<Profile> {
  if (fresh) return createProfile(path, fields);
  let existing: Profile;
  try {
    existing = await loadProfile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createProfile(path, fields);
    throw error;
  }
  const requested = profileSchema.parse({
    ...fields,
    formatVersion: 1,
    id: existing.id,
  });
  for (const key of imageFields)
    if (requested[key]) requested[key] = resolve(requested[key]!);
  for (const key of ["model", ...imageFields, "sdWiring", "deviceUid"] as const)
    if (existing[key] !== requested[key])
      throw new UserError("error.profileChanged");
  return existing;
}
