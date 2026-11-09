export const KEY_MAP: Record<string, number> = {
  ArrowLeft: 0,
  ArrowUp: 1,
  ArrowRight: 2,
  ArrowDown: 3,
  KeyX: 4,
  KeyZ: 5,
  KeyT: 6,
  KeyG: 7,
  KeyP: 8,
  KeyO: 9,
  Enter: 10,
  Tab: 11,
  KeyQ: 11,
};
export class InputController {
  private sources = new Map<string, number>();
  private mask = 0;
  private appliedMask = 0;
  private resetGeneration = 0;
  private chain = Promise.resolve();
  private failure?: unknown;
  constructor(
    private send: (mask: number) => Promise<unknown>,
    private changed: (state: {
      desiredMask: number;
      appliedMask: number;
      resetGeneration: number;
    }) => void = () => {},
  ) {}
  key(code: string, down: boolean, source = "keyboard") {
    const bit = KEY_MAP[code];
    if (bit === undefined) return;
    const id = `${source}:${code}`;
    if (down) this.sources.set(id, bit);
    else this.sources.delete(id);
    this.update();
  }
  button(bit: number, down: boolean, source: string) {
    if (!Number.isInteger(bit) || bit < 0 || bit > 11) return;
    if (down) {
      if (!this.sources.has(source) && this.sources.size >= 64) return;
      this.sources.set(source, bit);
    } else this.sources.delete(source);
    this.update();
  }
  releaseSources(prefix: string) {
    for (const source of this.sources.keys())
      if (source.startsWith(prefix)) this.sources.delete(source);
    this.publishReset();
  }
  releaseAll() {
    this.sources.clear();
    this.publishReset();
  }
  private publishReset() {
    this.resetGeneration++;
    const previous = this.mask;
    this.update();
    if (this.mask === previous) this.changed(this.snapshot);
  }
  private update() {
    let next = 0;
    for (const bit of this.sources.values()) next |= 1 << bit;
    if (next === this.mask) return;
    this.mask = next;
    this.changed(this.snapshot);
    this.chain = this.chain
      .then(() => this.send(next))
      .then(
        () => {
          this.appliedMask = next;
          this.changed(this.snapshot);
        },
        (e) => {
          this.failure = e;
        },
      );
  }
  async flush() {
    await this.chain;
    if (this.failure) throw this.failure;
  }
  get buttons() {
    return this.mask;
  }
  get snapshot() {
    return {
      desiredMask: this.mask,
      appliedMask: this.appliedMask,
      resetGeneration: this.resetGeneration,
    };
  }
}
