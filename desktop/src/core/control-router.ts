import type { AppState } from "../shared/contracts";
import {
  controlInputSchema,
  controlsSchema,
  inputIdentity,
  inputMatches,
  isHotkeyTarget,
  LOGICAL_BUTTONS,
  modifiersMatch,
  type ControlBinding,
  type ControlInputEvent,
  type ControlsSettings,
  type HotkeyAction,
} from "../shared/controls";

export interface ControlRouterCallbacks {
  button(bit: number, down: boolean, source: string): void;
  action(id: HotkeyAction): void;
  release(): void;
  physicalRelease?(): void;
  flush?(): Promise<void>;
  failed?(error: unknown): void;
}
interface ActiveBinding {
  binding: ControlBinding;
  source: string;
  outputSource: string;
  bit?: number;
  started: number;
  halfPeriod: number;
  on: boolean;
}
/** Main-owned routing. Physical transitions stay ordered; turbo phases skip busy QMP periods. */
export class ControlRouter {
  private config: ControlsSettings;
  private raw = new Map<string, ControlInputEvent>();
  private quarantined = new Set<string>();
  private active = new Map<string, ActiveBinding>();
  private blocked = false;
  private guestBlocked = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private schedulerBusy = false;
  private schedulerFailed = false;
  private generation = 0;
  constructor(
    config: ControlsSettings,
    private callbacks: ControlRouterCallbacks,
  ) {
    this.config = controlsSchema.parse(config);
  }
  get epoch() {
    return this.generation;
  }
  event(value: ControlInputEvent) {
    if (this.disposed) return;
    const parsed = controlInputSchema.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    const rawKey = JSON.stringify([event.source, inputIdentity(event.input)]);
    // Old presses cannot dispatch, but must still quarantine newly observed held inputs.
    const stalePress = event.down && event.epoch !== this.epoch;
    const repeated = this.raw.has(rawKey);
    if (event.down) {
      if (!repeated && this.raw.size >= 256) return;
      this.raw.set(rawKey, event);
      if (this.blocked || (stalePress && !repeated))
        this.quarantined.add(rawKey);
    } else {
      this.raw.delete(rawKey);
      this.quarantined.delete(rawKey);
    }
    if (this.blocked || stalePress) {
      if (!event.down) this.callbacks.physicalRelease?.();
      return;
    }
    if (event.down && (repeated || this.quarantined.has(rawKey))) return;
    const permitted =
      this.config.devices[
        event.input.kind === "gamepad" ? event.input.device : ""
      ]?.enabled !== false;
    if (!permitted && event.down) return;
    const generation = this.generation;
    for (const binding of this.config.bindings) {
      if (this.blocked || this.disposed || generation !== this.generation)
        break;
      const id = JSON.stringify([binding.id, event.source]);
      const active = this.active.get(id);
      if (
        binding.inputs[0].kind === "keyboard" &&
        isHotkeyTarget(binding.target)
      ) {
        if (
          event.down &&
          inputMatches(binding.inputs[0], event.input) &&
          modifiersMatch(binding.modifiers, event.modifiers)
        )
          this.callbacks.action(binding.target);
        continue;
      }
      if (this.guestBlocked && !isHotkeyTarget(binding.target)) continue;
      const held = binding.inputs.every((token) =>
        [...this.raw.entries()].some(
          ([key, input]) =>
            !this.quarantined.has(key) &&
            input.source === event.source &&
            (input.input.kind !== "gamepad" ||
              this.config.devices[input.input.device]?.enabled !== false) &&
            inputMatches(token, input.input),
        ),
      );
      if (!held) {
        if (active) this.stopBinding(id, active);
      } else if (!active && permitted) {
        // At most 64 sources feed the existing InputController's bounded aggregator.
        if (this.active.size >= 64) continue;
        if (isHotkeyTarget(binding.target)) {
          this.active.set(id, {
            binding,
            source: event.source,
            outputSource: "",
            started: 0,
            halfPeriod: 0,
            on: false,
          });
          this.callbacks.action(binding.target);
        } else {
          const bit = LOGICAL_BUTTONS.find(
            (button) => button.id === binding.target,
          )!.bit;
          const hz =
            binding.turbo === "default"
              ? this.config.defaultTurboHz
              : binding.turbo;
          if (hz && this.schedulerFailed) continue;
          const active: ActiveBinding = {
            binding,
            source: event.source,
            outputSource: `control:${id}`,
            bit,
            started: Date.now(),
            halfPeriod: hz ? 500 / hz : 0,
            on: true,
          };
          this.active.set(id, active);
          this.callbacks.button(bit, true, active.outputSource);
          if (hz) this.flushScheduler();
        }
      }
    }
    this.schedule();
    if (!event.down) this.callbacks.physicalRelease?.();
  }
  setBlocked(blocked: boolean, execution?: AppState["execution"]) {
    const guestBlocked = execution !== undefined && execution !== "running";
    if (
      this.disposed ||
      (this.blocked === blocked && this.guestBlocked === guestBlocked)
    )
      return;
    this.blocked = blocked;
    this.guestBlocked = guestBlocked;
    this.reset();
  }
  setConfig(config: ControlsSettings) {
    const next = controlsSchema.parse(config);
    this.reset();
    this.config = next;
  }
  releaseDevice(prefix: string) {
    for (const [key, event] of this.raw)
      if (event.source.startsWith(prefix)) {
        this.raw.delete(key);
        this.quarantined.delete(key);
      }
    for (const [id, active] of this.active)
      if (active.source.startsWith(prefix)) this.stopBinding(id, active);
    this.schedule();
  }
  reset() {
    this.generation++;
    this.cancelTimer();
    this.active.clear();
    for (const key of this.raw.keys()) this.quarantined.add(key);
    this.schedulerFailed = false;
    this.callbacks.release();
  }
  dispose() {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.raw.clear();
    this.quarantined.clear();
  }
  private stopBinding(id: string, active: ActiveBinding) {
    if (active.bit !== undefined && active.on)
      this.callbacks.button(active.bit, false, active.outputSource);
    this.active.delete(id);
  }
  private cancelTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule() {
    this.cancelTimer();
    if (this.blocked || this.disposed || this.schedulerFailed) return;
    const now = Date.now();
    let wait = Infinity;
    for (const active of this.active.values())
      if (active.halfPeriod) {
        const elapsed = Math.max(0, now - active.started);
        wait = Math.min(
          wait,
          active.halfPeriod - (elapsed % active.halfPeriod),
        );
      }
    if (Number.isFinite(wait))
      this.timer = setTimeout(() => this.tick(), Math.max(1, Math.ceil(wait)));
  }
  private tick() {
    this.timer = undefined;
    if (this.blocked || this.disposed || this.schedulerFailed) return;
    if (!this.schedulerBusy) {
      let changed = false;
      for (const active of this.active.values())
        if (active.halfPeriod && active.bit !== undefined) {
          const on =
            Math.floor((Date.now() - active.started) / active.halfPeriod) %
              2 ===
            0;
          if (on !== active.on) {
            active.on = on;
            this.callbacks.button(active.bit, on, active.outputSource);
            changed = true;
          }
        }
      if (changed) this.flushScheduler();
    }
    this.schedule();
  }
  private flushScheduler() {
    if (!this.callbacks.flush || this.schedulerBusy) return;
    this.schedulerBusy = true;
    const generation = this.generation;
    Promise.resolve()
      .then(() => {
        if (generation === this.generation && !this.disposed)
          return this.callbacks.flush!();
      })
      .then(
        () => {
          this.schedulerBusy = false;
        },
        (error) => {
          this.schedulerBusy = false;
          if (generation !== this.generation || this.disposed) return;
          this.schedulerFailed = true;
          this.cancelTimer();
          for (const [id, active] of this.active)
            if (active.halfPeriod) this.stopBinding(id, active);
          this.callbacks.failed?.(error);
        },
      );
  }
}
