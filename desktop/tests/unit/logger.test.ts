import { expect, test } from "vitest";
import { Writable } from "node:stream";
import { createLogManager } from "../../src/observability/logger";

test("structured logs can change levels and redact authentication without mixing stdout", () => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const manager = createLogManager({
    appInstanceId: "app-test",
    level: "info",
    destination,
  });
  const log = manager.child("qmp");
  log.debug({ event: "hidden" }, "not emitted");
  manager.configure({ level: "debug" });
  log.debug(
    {
      event: "request",
      token: "secret",
      runtimeSessionId: "session",
      sequence: 9007199254740993n,
    },
    "sent",
  );
  const record = JSON.parse(lines.join(""));
  expect(record).toMatchObject({
    module: "qmp",
    appInstanceId: "app-test",
    event: "request",
    runtimeSessionId: "session",
    sequence: "9007199254740993",
  });
  expect(JSON.stringify(record)).not.toContain("secret");
  expect(manager.tail({ limit: 10 }).records).toHaveLength(1);
});

test("recent logs are bounded and report overwritten records", () => {
  const manager = createLogManager({
    appInstanceId: "bounded",
    capacity: 2,
    destination: new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
  });
  const log = manager.child("session");
  for (let i = 0; i < 4; i++) log.info({ event: "state", index: i }, "changed");
  expect(manager.tail({ limit: 200 }).records.map((r) => r.index)).toEqual([
    2, 3,
  ]);
  expect(manager.tail({ limit: 200 }).overwritten).toBe(2);
  manager.configure({ modules: { session: "error" } });
  log.info({ event: "hidden" }, "hidden");
  expect(manager.tail({ limit: 200 }).records).toHaveLength(2);
});

test("errors keep stack and cause while cursor/module filters isolate a recent range", () => {
  const manager = createLogManager({
    appInstanceId: "errors",
    destination: new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
  });
  manager.child("qmp").error(
    {
      err: new Error("outer", { cause: new Error("inner") }),
      event: "failed",
    },
    "failed",
  );
  const record = manager.tail({ module: "qmp" }).records[0];
  expect(record.err.message).toContain("outer");
  expect(record.err.stack).toContain("inner");
  expect(manager.tail({ after: record.cursor }).records).toHaveLength(0);
});
