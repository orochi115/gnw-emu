import { join } from "node:path";
import type { Profile } from "./schemas";
import type { Session } from "./session-store";
export function qemuEscape(value: string) {
  return value.replaceAll(",", ",,");
}
export function qemuArguments(
  profile: Profile,
  session: Session,
  settings: { audio: boolean; realtime: boolean },
  endpoints: { qmpPort: number; framePort: number; stateFile: string },
) {
  const options: Record<string, string | number> = {
    internal: profile.internalFlash,
    external: profile.externalFlash,
    overlay: session.externalFlash,
    "bank1-overlay": session.internalFlash,
    battery: session.battery,
    "usb-power": session.usbPower ? "on" : "off",
    "battery-life-min": session.batteryLifeMinutes,
    "charge-time-min": session.chargeTimeMinutes,
    audio: settings.audio ? "on" : "off",
    realtime: settings.realtime ? "on" : "off",
    "frame-endpoint": `127.0.0.1:${endpoints.framePort}`,
    "session-lock": join(session.directory, "qemu.lock"),
    "state-file": endpoints.stateFile,
  };
  if (profile.bank2Flash) {
    options.bank2 = profile.bank2Flash;
    options["bank2-overlay"] = session.bank2Flash!;
  }
  if (profile.deviceUid) options.uid = profile.deviceUid;
  if (profile.sdCard) options["sd-wiring"] = profile.sdWiring ?? "spi1";
  const args = [
    "-M",
    [
      `gnw-${profile.model}`,
      ...Object.entries(options).map(
        ([k, v]) => `${k}=${qemuEscape(String(v))}`,
      ),
    ].join(","),
    "-S",
    "-display",
    "none",
    "-qmp",
    `tcp:127.0.0.1:${endpoints.qmpPort},server=off`,
    "-rtc",
    session.rtc === "host" ? "base=localtime" : `base=${session.rtc},clock=vm`,
  ];
  if (settings.realtime) args.push("-icount", "shift=2,sleep=off");
  if (session.sdCard)
    args.push("-drive", `if=sd,format=raw,file=${qemuEscape(session.sdCard)}`);
  return args;
}
