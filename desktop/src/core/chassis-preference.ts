import type { ViewPreferences } from "../shared/contracts";
/** Owns committed state. Disk failure must never leave the UI claiming success. */
export class ChassisPreference {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private visible: boolean,
    private options: {
      persist: (visible: boolean) => Promise<unknown>;
      release: () => void;
      publish: (value: ViewPreferences) => void | Promise<void>;
    },
  ) {}
  get current(): ViewPreferences {
    return { showChassis: this.visible };
  }
  toggle() {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const next = !this.visible;
        this.options.release();
        await this.options.persist(next);
        // A press may arrive while disk I/O is pending. Clear it before hiding,
        // while preserving keyboard ownership of the same logical button.
        this.options.release();
        this.visible = next;
        await this.options.publish(this.current);
      });
    this.queue = work;
    return work;
  }
  async settled() {
    await this.queue.catch(() => {});
  }
}
