import { expect, test } from "vitest";
import { ViewSettings } from "../../src/core/view-settings";

test("exit flush merges pending view edits and waits for durable writes", async () => {
  const written: any[] = [];
  const store = new ViewSettings(
    async (patch) => {
      written.push(patch);
    },
    () => {},
    10000,
  );
  store.update({ normalScale: 3 });
  store.update({ clockScale: 0.5, clockMode: true });
  store.update({ clockBounds: { x: 25, y: 40, width: 80, height: 60 } });
  await store.flush();
  expect(written).toEqual([
    {
      normalScale: 3,
      clockScale: 0.5,
      clockMode: true,
      clockBounds: { x: 25, y: 40, width: 80, height: 60 },
    },
  ]);
});

test("a failed write is reported and later edits still persist", async () => {
  let attempts = 0;
  const errors: Error[] = [],
    written: any[] = [];
  const store = new ViewSettings(
    async (patch) => {
      if (++attempts === 1) throw Error("disk unavailable");
      written.push(patch);
    },
    (error) => errors.push(error),
    10000,
  );
  store.update({ clockScale: 0.5 });
  await store.flush();
  expect(errors.map((e) => e.message)).toEqual(["disk unavailable"]);
  store.update({ normalScale: 2 });
  await store.flush();
  expect(written).toEqual([{ normalScale: 2 }]);
});

test("exit flush also drains edits arriving while the first write is in flight", async () => {
  let finish!: () => void, started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const writes: any[] = [];
  const store = new ViewSettings(
    async (patch) => {
      writes.push(patch);
      if (writes.length === 1) {
        started();
        await gate;
      }
    },
    () => {},
    10000,
  );
  store.update({ clockMode: true });
  const flushed = store.flush();
  await began;
  store.update({ clockScale: 0.5 });
  finish();
  await flushed;
  try {
    expect(writes).toEqual([{ clockMode: true }, { clockScale: 0.5 }]);
  } finally {
    await store.flush();
  }
});
