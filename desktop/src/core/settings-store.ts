import { join } from "node:path";
import { settingsSchema } from "./schemas";
import { readJson, writeJson } from "./atomic-file";
import type { z } from "zod";
const updates = new Map<string, Promise<unknown>>();
/** Serialize read-modify-write so unrelated settings are never lost. */
export function updateSettings(
  userData: string,
  patch: Partial<z.infer<typeof settingsSchema>>,
) {
  const path = join(userData, "settings.json");
  const work = (updates.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const next = settingsSchema.parse({
        ...(await loadSettings(userData)),
        ...patch,
      });
      await writeJson(path, next);
      return next;
    });
  updates.set(path, work);
  void work
    .finally(() => {
      if (updates.get(path) === work) updates.delete(path);
    })
    .catch(() => {});
  return work;
}
export async function loadSettings(userData: string) {
  const path = join(userData, "settings.json");
  try {
    return settingsSchema.parse(await readJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const defaults = settingsSchema.parse({ formatVersion: 1 });
    await writeJson(path, defaults);
    return defaults;
  }
}
