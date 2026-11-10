import { expect, test } from "vitest";
import { defaultControls } from "../../src/shared/controls";
import { ControlSettingsTransaction } from "../../src/core/control-settings-transaction";

test("opening isolates before the QMP release barrier and failed saves keep isolation", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settings = new ControlSettingsTransaction(defaultControls(), {
    block: (value) => calls.push(`block:${value}`),
    flush: () => barrier,
    persist: async () => {
      throw Error("disk full");
    },
    apply: () => calls.push("apply"),
  });
  const opening = settings.open();
  expect(calls).toEqual(["block:true"]);
  expect(settings.opened).toBe(true);
  finish();
  const draft = await opening;
  draft.defaultTurboHz = 15;
  await expect(settings.save(draft)).rejects.toThrow("disk full");
  expect(settings.config.defaultTurboHz).toBe(10);
  expect(settings.opened).toBe(true);
  expect(calls).toEqual(["block:true"]);
  settings.close();
  expect(calls.at(-1)).toBe("block:false");
});

test("save applies only persisted data and cannot be canceled mid write", async () => {
  let finish!: () => void;
  let applied: number | undefined;
  const settings = new ControlSettingsTransaction(defaultControls(), {
    block() {},
    flush: async () => {},
    persist: () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    apply: (cfg) => {
      applied = cfg.defaultTurboHz;
    },
  });
  const draft = await settings.open();
  draft.defaultTurboHz = 6;
  const saving = settings.save(draft);
  expect(applied).toBeUndefined();
  expect(() => settings.close()).toThrow();
  finish();
  await saving;
  expect(applied).toBe(6);
  expect(settings.config.defaultTurboHz).toBe(6);
  settings.close();
  expect(settings.opened).toBe(false);
});

test("renderer teardown closes a draft safely during an outstanding settings write", async () => {
  let finish!: () => void;
  const events: string[] = [];
  const settings = new ControlSettingsTransaction(defaultControls(), {
    block: (value) => events.push(`block:${value}`),
    flush: async () => {},
    persist: () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    apply: () => events.push("apply"),
  });
  const draft = await settings.open();
  draft.defaultTurboHz = 6;
  const saving = settings.save(draft);
  settings.abandon();
  expect(settings.opened).toBe(false);
  await expect(settings.open()).rejects.toThrow("busy");
  finish();
  await saving;
  expect(settings.config.defaultTurboHz).toBe(6);
  expect(events).toEqual(["block:true", "block:false", "apply"]);
});

test("abandon invalidates a pending open without canceling a later draft", async () => {
  let finish!: () => void;
  const barrier = new Promise<void>((r) => {
    finish = r;
  });
  const settings = new ControlSettingsTransaction(defaultControls(), {
    block() {},
    flush: () => barrier,
    persist: async () => {},
    apply() {},
  });
  const abandoned = settings.open();
  settings.abandon();
  const newer = settings.open();
  finish();
  await expect(abandoned).rejects.toThrow("canceled");
  await expect(newer).resolves.toHaveProperty("version", 1);
  expect(settings.opened).toBe(true);
});
