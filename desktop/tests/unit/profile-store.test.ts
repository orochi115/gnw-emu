import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfile, loadProfile } from "../../src/core/profile-store";
import { prepareSession, saveSession } from "../../src/core/session-store";
import { profileSchema, sessionSchema } from "../../src/core/schemas";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gnw-json-"));
  roots.push(root);
  await writeFile(join(root, "bank1.bin"), Buffer.alloc(128 * 1024));
  await writeFile(join(root, "ext.bin"), Buffer.alloc(1024 * 1024));
  return root;
}
test("relative profile paths survive moving as a unit and each creation gets a new identity", async () => {
  const root = await fixture();
  const fields = {
    model: "zelda" as const,
    internalFlash: join(root, "bank1.bin"),
    externalFlash: join(root, "ext.bin"),
  };
  const first = await createProfile(join(root, "one.gnw.json"), fields);
  const second = await createProfile(join(root, "two.gnw.json"), fields);
  expect(first.id).not.toBe(second.id);
  const file = JSON.parse(await readFile(join(root, "one.gnw.json"), "utf8"));
  expect(file.internalFlash).toBe("bank1.bin");
  expect((await loadProfile(join(root, "one.gnw.json"))).internalFlash).toBe(
    join(root, "bank1.bin"),
  );
  await expect(loadProfile(join(root, "one.gnw.toml"))).rejects.toThrow(
    /gnw.json/,
  );
});
test("session copies are isolated, never replace a save, and persist only device state", async () => {
  const root = await fixture();
  const profile = await createProfile(join(root, "rom.gnw.json"), {
    model: "mario",
    internalFlash: join(root, "bank1.bin"),
    externalFlash: join(root, "ext.bin"),
  });
  const session = await prepareSession(profile, join(root, "UserData"));
  await writeFile(session.externalFlash, "saved");
  const again = await prepareSession(profile, join(root, "UserData"));
  expect(await readFile(again.externalFlash, "utf8")).toBe("saved");
  expect((await readFile(profile.externalFlash)).length).toBe(1024 * 1024);
  await saveSession(again, { battery: 38, usbPower: true });
  const state = JSON.parse(
    await readFile(join(session.directory, "session.json"), "utf8"),
  );
  expect(state.battery).toBe(38);
  expect(state.usbPower).toBe(true);
  expect(state).not.toHaveProperty("externalFlash");
});
test("rejects invalid hardware and state types with conditional SD wiring", () => {
  expect(() =>
    profileSchema.parse({ formatVersion: 1, id: "bad", model: "zelda" }),
  ).toThrow();
  expect(() => sessionSchema.parse({ battery: "38" })).toThrow();
  expect(() =>
    profileSchema.parse({
      formatVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      model: "zelda",
      internalFlash: "a",
      externalFlash: "b",
      sdWiring: "ospi",
    }),
  ).toThrow(/sdCard/);
});

test("script profile ensure reuses only the same JSON configuration and refresh uses new identity", async () => {
  const { ensureProfile } = await import("../../src/core/profile-store");
  const root = await fixture();
  const path = join(root, "rom.gnw.json");
  const fields = {
    model: "zelda" as const,
    internalFlash: join(root, "bank1.bin"),
    externalFlash: join(root, "ext.bin"),
  };
  const first = await ensureProfile(path, fields);
  expect((await ensureProfile(path, fields)).id).toBe(first.id);
  await expect(
    ensureProfile(path, { ...fields, model: "mario" }),
  ).rejects.toThrow(/不同/);
  expect((await ensureProfile(path, fields, true)).id).not.toBe(first.id);
});
