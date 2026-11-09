import { join } from "node:path";
import { settingsSchema } from "./schemas";
import { readJson, writeJson } from "./atomic-file";
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
