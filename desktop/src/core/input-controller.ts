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
};
export class InputController {
  private sources = new Map<string, number>();
  private mask = 0;
  private chain = Promise.resolve();
  private failure?: unknown;
  constructor(private send: (mask: number) => Promise<unknown>) {}
  key(code: string, down: boolean, source = "keyboard") {
    const bit = KEY_MAP[code];
    if (bit === undefined) return;
    const id = `${source}:${code}`;
    if (down) this.sources.set(id, bit);
    else this.sources.delete(id);
    this.update();
  }
  releaseAll() {
    this.sources.clear();
    this.update();
  }
  private update() {
    let next = 0;
    for (const bit of this.sources.values()) next |= 1 << bit;
    if (next === this.mask) return;
    this.mask = next;
    this.chain = this.chain
      .then(() => this.send(next))
      .then(
        () => {},
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
}
