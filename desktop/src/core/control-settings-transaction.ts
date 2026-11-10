import { controlsSchema, type ControlsSettings } from "../shared/controls";

/** One isolated draft; persistence is the commit point for runtime mappings. */
export class ControlSettingsTransaction {
  opened = false;
  private saving = false;
  private generation = 0;
  get revision() {
    return this.generation;
  }
  isOpen(revision: number) {
    return this.opened && this.generation === revision;
  }
  constructor(
    public config: ControlsSettings,
    private readonly effects: {
      block(open: boolean): void;
      flush(): Promise<void>;
      persist(config: ControlsSettings): Promise<unknown>;
      apply(config: ControlsSettings): void;
    },
  ) {}
  async open() {
    if (this.opened || this.saving) throw Error("Control settings busy");
    const revision = ++this.generation;
    this.opened = true;
    this.effects.block(true);
    try {
      await this.effects.flush();
      if (!this.isOpen(revision)) throw Error("Control settings canceled");
      return structuredClone(this.config);
    } catch (error) {
      if (this.isOpen(revision)) this.abandon();
      throw error;
    }
  }
  async save(draft: ControlsSettings) {
    if (!this.opened || this.saving) throw Error("Control settings busy");
    const validated = controlsSchema.parse(draft);
    this.saving = true;
    try {
      await this.effects.persist(validated);
      this.config = validated;
      this.effects.apply(validated);
    } finally {
      this.saving = false;
    }
  }
  /** Renderer teardown abandons the UI draft; an accepted disk write still commits. */
  abandon() {
    if (!this.opened) return;
    this.generation++;
    this.opened = false;
    this.effects.block(false);
  }
  close() {
    if (this.saving) throw Error("Control settings busy");
    if (!this.opened) return;
    this.generation++;
    this.opened = false;
    this.effects.block(false);
  }
}
