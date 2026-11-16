import { UserError } from "../shared/user-error";

export function recoverableKernelFailure(error: unknown) {
  if (error instanceof UserError) {
    if (error.code === "error.timeout")
      return ["connect", "prepareDisplay", "firstFrame", "start"].includes(
        String(error.params.action),
      );
    return [
      "error.kernelConnection",
      "error.startup",
      "error.exited",
      "error.displayExited",
      "error.controlDisconnected",
    ].includes(error.code);
  }
  return (
    error instanceof Error &&
    /ECONNRESET|EPIPE|QMP disconnected|画面连接已断开/.test(error.message)
  );
}

/** Serial, cancellable recovery. Reuses session files; never restores snapshots. */
export class KernelRecovery {
  private generation = 0;
  private desired?: string;
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private cancelWait?: () => void;
  private retries: number[] = [];
  private closed = false;
  recovering = false;
  constructor(
    private options: {
      start: (path: string) => Promise<void>;
      stop: () => Promise<void>;
      log: (event: string, fields: Record<string, unknown>) => void;
      recovered?: () => void;
    },
  ) {}
  private cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.cancelWait?.();
    this.cancelWait = undefined;
  }
  load(path: string): Promise<void> {
    if (this.closed)
      return Promise.reject(new UserError("error.startCancelled"));
    const prior = this.work;
    this.cancel();
    const generation = this.generation;
    this.desired = path;
    this.retries = [];
    return this.track(
      (async () => {
        if (prior) {
          await this.options.stop();
          await prior.catch(() => {});
        }
        this.check(generation);
        await this.run(path, generation);
      })(),
    );
  }
  recover(error: unknown, oldSessionId?: string): Promise<void> {
    if (this.closed || !this.desired || !recoverableKernelFailure(error))
      return Promise.resolve();
    if (this.work) return this.work;
    const generation = this.generation;
    this.options.log("recovery.failure", {
      error,
      oldSessionId,
      profilePath: this.desired,
    });
    return this.track(this.run(this.desired, generation, error));
  }
  private track(work: Promise<void>) {
    this.work = work;
    work.catch(() => {});
    void work
      .finally(() => {
        if (this.work === work) {
          this.work = undefined;
          this.recovering = false;
        }
      })
      .catch(() => {});
    return work;
  }
  private check(generation: number) {
    if (this.closed || generation !== this.generation)
      throw new UserError("error.startCancelled");
  }
  private async run(path: string, generation: number, failure?: unknown) {
    let error = failure;
    let recovered = false;
    for (;;) {
      this.check(generation);
      if (error) {
        if (!recoverableKernelFailure(error)) throw error;
        const now = Date.now();
        this.retries = this.retries.filter((t) => now - t < 5 * 60_000);
        if (this.retries.length >= 3) {
          this.options.log("recovery.exhausted", {
            error,
            attempts: this.retries.length,
            profilePath: path,
          });
          throw error;
        }
        this.retries.push(now);
        const attempt = this.retries.length;
        const delayMs = 1000 * 2 ** (attempt - 1);
        this.recovering = true;
        this.options.log("recovery.scheduled", {
          error,
          attempt,
          delayMs,
          profilePath: path,
        });
        await this.options.stop().catch(() => {});
        this.check(generation);
        await new Promise<void>((resolve) => {
          this.cancelWait = resolve;
          this.timer = setTimeout(resolve, delayMs);
        });
        this.cancelWait = undefined;
        this.check(generation);
        this.options.log("recovery.attempt", { attempt, profilePath: path });
        recovered = true;
      }
      try {
        await this.options.start(path);
        this.check(generation);
        if (recovered) {
          this.options.log("recovery.succeeded", {
            attempts: this.retries.length,
            profilePath: path,
          });
          this.options.recovered?.();
        }
        return;
      } catch (failure) {
        this.check(generation);
        error = failure;
      }
    }
  }
  async stop() {
    this.desired = undefined;
    this.cancel();
    await this.options.stop();
    await this.work?.catch(() => {});
    this.recovering = false;
  }
  dispose() {
    this.closed = true;
    this.desired = undefined;
    this.cancel();
  }
}
