/** Keeps one baseline per live kernel, not an unbounded sample history. */
export class MemoryMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  private baseline?: { id: string; bytes: number; at: number; warned: number };
  constructor(
    private options: {
      sample: () => Promise<{
        id?: string;
        privateBytes?: number;
        [key: string]: unknown;
      }>;
      log: (
        event: string,
        fields: Record<string, unknown>,
        warning?: boolean,
      ) => void;
      intervalMs?: number;
    },
  ) {}
  start() {
    if (this.timer || this.closed) return;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.intervalMs ?? 60_000,
    );
    this.timer.unref?.();
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const sample = await this.options.sample();
      if (this.closed) return;
      const now = Date.now();
      this.options.log("memory.sample", sample);
      if (!sample.id || sample.privateBytes === undefined) {
        this.baseline = undefined;
        return;
      }
      if (this.baseline?.id !== sample.id)
        this.baseline = {
          id: sample.id,
          bytes: sample.privateBytes,
          at: now,
          warned: now,
        };
      const base = this.baseline;
      const growthBytes = sample.privateBytes - base.bytes;
      if (
        now - base.at >= 5 * 60_000 &&
        now - base.warned >= 10 * 60_000 &&
        growthBytes > Math.max(128 * 1024 * 1024, base.bytes * 0.2)
      ) {
        base.warned = now;
        this.options.log(
          "memory.growth",
          {
            ...sample,
            growthBytes,
            elapsedMs: now - base.at,
            note: "Retained growth warrants investigation; this does not prove a leak.",
          },
          true,
        );
      }
    } catch (error) {
      if (!this.closed) this.options.log("memory.sample.failed", { error });
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.baseline = undefined;
  }
}
