/** Commit the host preference only after QMP and disk succeed; roll back live audio on disk failure. */
export class AudioPreference {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    public enabled: boolean,
    private options: {
      apply: (enabled: boolean) => Promise<void>;
      persist: (enabled: boolean) => Promise<unknown>;
    },
  ) {}
  toggle() {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const next = !this.enabled;
        await this.options.apply(next);
        try {
          await this.options.persist(next);
        } catch (error) {
          try {
            await this.options.apply(this.enabled);
          } catch (rollback) {
            throw new AggregateError(
              [error, rollback],
              "Could not save or restore audio preference",
            );
          }
          throw error;
        }
        this.enabled = next;
      });
    this.queue = work;
    return work;
  }
}
