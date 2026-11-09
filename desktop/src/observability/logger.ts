import pino, { type DestinationStream, type Level } from "pino";
import { Writable } from "node:stream";
export interface LogConfig {
  level?: Level;
  modules?: Record<string, Level>;
}
export function createLogManager(options: {
  appInstanceId: string;
  level?: Level;
  capacity?: number;
  destination?: DestinationStream;
}) {
  let config: LogConfig = { level: options.level ?? "info", modules: {} };
  const records: Record<string, any>[] = [];
  let cursor = 0;
  let overwritten = 0;
  const capacity = Math.min(options.capacity ?? 2000, 2000);
  const destination = options.destination ?? process.stderr;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      const record = JSON.parse(chunk.toString());
      record.cursor = ++cursor;
      records.push(record);
      if (records.length > capacity) {
        records.shift();
        overwritten++;
      }
      destination.write(JSON.stringify(record) + "\n");
      done();
    },
  });
  const base = pino(
    {
      level: "trace",
      base: { appInstanceId: options.appInstanceId, source: "main" },
      redact: ["token", "authorization", "*.token", "*.authorization"],
      serializers: { err: pino.stdSerializers.err },
      formatters: {
        log: (value) =>
          JSON.parse(
            JSON.stringify(value, (_k, v) =>
              v instanceof Error
                ? pino.stdSerializers.err(v)
                : typeof v === "bigint"
                  ? String(v)
                  : v,
            ),
          ),
      },
    },
    sink,
  );
  const children = new Map<string, pino.Logger>();
  return {
    child(module: string) {
      let child = children.get(module);
      if (!child) {
        child = base.child({ module });
        child.level = config.modules?.[module] ?? config.level!;
        children.set(module, child);
      }
      return child;
    },
    configure(update: LogConfig) {
      config = { ...config, ...update };
      for (const [module, child] of children)
        child.level = config.modules?.[module] ?? config.level!;
      return config;
    },
    getConfig: () => config,
    tail(
      query: {
        limit?: number;
        after?: number;
        module?: string;
        level?: number;
      } = {},
    ) {
      return {
        records: records
          .filter(
            (r) =>
              r.cursor > (query.after ?? 0) &&
              (!query.module || r.module === query.module) &&
              (!query.level || r.level >= query.level),
          )
          .slice(-Math.max(1, Math.min(query.limit ?? 100, 200))),
        cursor,
        overwritten,
      };
    },
  };
}
