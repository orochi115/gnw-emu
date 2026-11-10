interface DeviceParticipation {
  instance: string;
  enabled: boolean;
}
type ChangeParticipation = (instance: string, enabled: boolean) => void;
/** Runtime instance preferences are a draft transaction, including new connections. */
export class DeviceParticipationDraft {
  private original = new Map<string, boolean>();
  change(
    device: DeviceParticipation,
    enabled: boolean,
    change?: ChangeParticipation,
  ) {
    if (!this.original.has(device.instance))
      this.original.set(device.instance, device.enabled);
    change?.(device.instance, enabled);
  }
  cancel(
    devices: readonly DeviceParticipation[],
    change?: ChangeParticipation,
  ) {
    for (const device of devices)
      if (this.original.has(device.instance))
        change?.(device.instance, this.original.get(device.instance)!);
    this.original.clear();
  }
}
