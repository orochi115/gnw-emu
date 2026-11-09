import { resolve } from "node:path";

export const RECENT_ROM_LIMIT = 10;

/** Host preference only: publish after durable writes; failed writes leave the menu intact. */
export class RecentRoms {
  private paths: string[];
  private writing: Promise<unknown> = Promise.resolve();
  constructor(
    initial: string[],
    private persist: (paths: string[]) => Promise<unknown>,
  ) {
    this.paths = [...new Set(initial.map((path) => resolve(path)))].slice(
      0,
      RECENT_ROM_LIMIT,
    );
  }
  get entries() {
    return [...this.paths];
  }
  record(path: string) {
    const absolute = resolve(path);
    return this.change(() =>
      [absolute, ...this.paths.filter((p) => p !== absolute)].slice(
        0,
        RECENT_ROM_LIMIT,
      ),
    );
  }
  clear() {
    return this.change(() => []);
  }
  private change(next: () => string[]) {
    const work = this.writing
      .catch(() => {})
      .then(async () => {
        const paths = next();
        await this.persist(paths);
        this.paths = paths;
      });
    this.writing = work;
    return work;
  }
}
