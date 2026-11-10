import type {
  ControlInputEvent,
  GamepadParticipation,
  ControlsSettings,
  InputToken,
} from "../../shared/controls";
export interface GamepadSnapshot {
  index: number;
  id: string;
  mapping: string;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}
export interface GamepadDevice {
  index: number;
  instance: string;
  fingerprint: string;
  name: string;
  enabled: boolean;
  collision: boolean;
  standard: boolean;
}
function identityHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
export function gamepadFingerprint(pad: GamepadSnapshot) {
  return `${pad.mapping === "standard" ? "standard" : "raw"}:${encodeURIComponent(pad.id).slice(0, 150)}:${identityHash(JSON.stringify([pad.id, pad.mapping, pad.buttons.length, pad.axes.length]))}`;
}
interface ControlState {
  down: boolean;
  ready: boolean;
  input: InputToken;
}
interface DeviceState {
  index: number;
  instance: string;
  fingerprint: string;
  controls: Map<string, ControlState>;
  name: string;
  standard: boolean;
}
export class GamepadInputReader {
  private instances = new Map<number, DeviceState>();
  private overrides = new Map<string, boolean>();
  private serial = 0;
  private pendingParticipation: GamepadParticipation[] = [];
  importParticipation(devices: GamepadParticipation[]) {
    this.pendingParticipation = devices.filter((value) => {
      const device = this.instances.get(value.index);
      if (!device) return true;
      if (device.fingerprint === value.fingerprint)
        this.overrides.set(device.instance, value.enabled);
      return false;
    });
  }
  participation(config: ControlsSettings): GamepadParticipation[] {
    return [
      ...this.pendingParticipation,
      ...[...this.instances.values()].map((device) => ({
        index: device.index,
        fingerprint: device.fingerprint,
        enabled:
          this.overrides.get(device.instance) ??
          config.devices[device.fingerprint]?.enabled ??
          true,
      })),
    ];
  }
  participate(instance: string, enabled: boolean) {
    this.overrides.set(instance, enabled);
  }
  private release(device: DeviceState, epoch: number) {
    const events: ControlInputEvent[] = [];
    for (const [control, state] of device.controls) {
      if (state.down)
        events.push({
          source: `gamepad:${device.instance}`,
          input: state.input,
          down: false,
          modifiers: [],
          epoch,
        });
      state.down = false;
      state.ready = false;
    }
    return events;
  }
  suspend(epoch: number) {
    return [...this.instances.values()].flatMap((device) =>
      this.release(device, epoch),
    );
  }
  sample(
    snapshots: readonly (GamepadSnapshot | null)[],
    config: ControlsSettings,
    epoch: number,
  ): { events: ControlInputEvent[]; devices: GamepadDevice[] } {
    const events: ControlInputEvent[] = [];
    const active = snapshots
      .filter(
        (pad): pad is GamepadSnapshot =>
          !!pad &&
          pad.connected &&
          Number.isInteger(pad.index) &&
          pad.index >= 0,
      )
      .slice(0, 16);
    const seen = new Set<number>();
    for (const pad of active) {
      const fingerprint = gamepadFingerprint(pad);
      let device = this.instances.get(pad.index);
      if (device && device.fingerprint !== fingerprint) {
        events.push(...this.release(device, epoch));
        this.overrides.delete(device.instance);
        this.instances.delete(pad.index);
        device = undefined;
      }
      if (!device) {
        device = {
          index: pad.index,
          instance: `p${++this.serial}`,
          fingerprint,
          controls: new Map(),
          name: pad.id || "Unidentified controller",
          standard: pad.mapping === "standard",
        };
        this.instances.set(pad.index, device);
      }
      const imported = this.pendingParticipation.find(
        (value) =>
          value.index === pad.index && value.fingerprint === fingerprint,
      );
      if (imported) this.overrides.set(device.instance, imported.enabled);
      seen.add(pad.index);
      const enabled =
        this.overrides.get(device.instance) ??
        config.devices[fingerprint]?.enabled ??
        true;
      const deadzone = config.devices[fingerprint]?.deadzone ?? 0.2;
      const enter = deadzone + 0.05;
      const visit = (
        control: string,
        input: InputToken,
        pressed: boolean,
        neutral: boolean,
      ) => {
        let state = device!.controls.get(control);
        if (!state) {
          state = { down: false, ready: neutral, input };
          device!.controls.set(control, state);
        }
        if (neutral) state.ready = true;
        const down = enabled && state.ready && pressed;
        if (down !== state.down) {
          state.down = down;
          events.push({
            source: `gamepad:${device!.instance}`,
            input,
            down,
            modifiers: [],
            epoch,
          });
        }
        if (!enabled && !neutral) state.ready = false;
      };
      for (let index = 0; index < Math.min(pad.buttons.length, 64); index++) {
        const button = pad.buttons[index];
        const pressed =
          button.pressed ||
          (Number.isFinite(button.value) && button.value > 0.5);
        visit(
          `button${index}`,
          { kind: "gamepad", device: fingerprint, control: "button", index },
          pressed,
          !pressed,
        );
      }
      for (let index = 0; index < Math.min(pad.axes.length, 16); index++) {
        const raw = pad.axes[index];
        const finite = Number.isFinite(raw);
        const value = finite ? Math.max(-1, Math.min(1, raw)) : 0;
        for (const direction of [-1, 1] as const) {
          const control = `axis${index}:${direction}`;
          const previous = device.controls.get(control);
          const magnitude = value * direction;
          const pressed =
            finite && magnitude > (previous?.down ? deadzone : enter);
          visit(
            control,
            {
              kind: "gamepad",
              device: fingerprint,
              control: "axis",
              index,
              direction,
            },
            pressed,
            finite && Math.abs(value) <= deadzone,
          );
        }
      }
    }
    for (const [index, device] of this.instances)
      if (!seen.has(index)) {
        events.push(...this.release(device, epoch));
        this.overrides.delete(device.instance);
        this.instances.delete(index);
      }
    // Chromium can initially hide pads until an interaction in this renderer.
    this.pendingParticipation = this.pendingParticipation.filter(
      (value) => !seen.has(value.index),
    );
    const counts = new Map<string, number>();
    for (const device of this.instances.values())
      counts.set(device.fingerprint, (counts.get(device.fingerprint) ?? 0) + 1);
    const devices = [...this.instances.values()].map((device) => ({
      index: device.index,
      instance: device.instance,
      fingerprint: device.fingerprint,
      name: device.name,
      standard: device.standard,
      collision: (counts.get(device.fingerprint) ?? 0) > 1,
      enabled:
        this.overrides.get(device.instance) ??
        config.devices[device.fingerprint]?.enabled ??
        true,
    }));
    return { events, devices };
  }
}
