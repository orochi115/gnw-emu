import type { Settings } from "./schemas";
export type ViewSettingsPatch = Partial<
  Pick<
    Settings,
    "normalScale" | "clockScale" | "clockMode" | "clockBounds" | "clockDock"
  >
>;

/** Coalesce drag/resize events; ordered writes and exit flush share one queue. */
export class ViewSettings {
  private pending: ViewSettingsPatch = {};
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private persist: (patch: ViewSettingsPatch) => Promise<unknown>,
    private failed: (error: Error) => void,
    private delay = 250,
  ) {}
  update(patch: ViewSettingsPatch) {
    Object.assign(this.pending, patch);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.delay);
  }
  async flush() {
    for (;;) {
      clearTimeout(this.timer);
      this.timer = undefined;
      const patch = this.pending;
      this.pending = {};
      if (Object.keys(patch).length) {
        this.writing = this.writing.then(async () => {
          try {
            await this.persist(patch);
          } catch (error) {
            this.failed(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        });
      }
      const writing = this.writing;
      await writing;
      if (writing === this.writing && !Object.keys(this.pending).length) return;
    }
  }
}
