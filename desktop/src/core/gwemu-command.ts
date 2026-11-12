import type { Profile } from "./schemas";
import type { Session } from "./session-store";
import { qemuEscape } from "./qemu-command";
import { join } from "node:path";

// Capacity-matched Macronix entries from the pinned upstream gnw_h7b0_nor.h.
const chips = new Map([
  [1, "c2-25-34"],
  [4, "c2-25-36"],
  [8, "c2-25-37"],
  [16, "c2-25-38"],
  [32, "c2-25-39"],
  [64, "c2-25-3a"],
  [128, "c2-25-3b"],
  [256, "c2-25-3c"],
]);

export interface GwemuSizes {
  internalFlash: number;
  externalFlash: number;
  bank2Flash?: number;
}
export function validateGwemuConfiguration(
  profile: Profile,
  sizes: GwemuSizes,
) {
  if (profile.deviceUid && !/^[a-fA-F0-9]{24}$/.test(profile.deviceUid))
    throw new Error(
      "gwemu UID must contain exactly 12 raw bytes in hexadecimal",
    );
  for (const size of [sizes.internalFlash, sizes.bank2Flash])
    if (
      size !== undefined &&
      (!Number.isInteger(size) || size <= 0 || size > 256 * 1024)
    )
      throw new Error(
        "gwemu internal banks must be nonempty and at most 256 KiB",
      );
  const chip = chips.get(sizes.externalFlash / (1024 * 1024));
  if (!chip)
    throw new Error(
      `Unsupported gwemu external Flash capacity: ${sizes.externalFlash}`,
    );
  return chip;
}

/** Shared session mapping; desktop transport is enabled only with a frame endpoint. */
export function gwemuArguments(
  profile: Profile,
  session: Session,
  endpoints: { qmpPort: number; gdbSocket?: string; framePort?: number },
  sizes: GwemuSizes,
  settings?: { audio: boolean },
) {
  const chip = validateGwemuConfiguration(profile, sizes);
  const wiring = `gnw-h7b0,sd-wiring=${profile.sdWiring ?? "spi1"}`;
  const machine =
    endpoints.framePort === undefined
      ? wiring
      : `${wiring},frame-endpoint=127.0.0.1:${endpoints.framePort},session-lock=${qemuEscape(join(session.directory, "qemu.lock"))},power-model=on,battery=${session.battery},battery-present=${session.batteryPresent === false ? "off" : "on"},usb-power=${session.usbPower ? "on" : "off"},battery-life-min=${session.batteryLifeMinutes},charge-time-min=${session.chargeTimeMinutes}`;
  const args = [
    "-M",
    machine,
    "-S",
    "-display",
    "none",
    "-qmp",
    `tcp:127.0.0.1:${endpoints.qmpPort},server=off`,
    "-rtc",
    session.rtc === "host" ? "base=localtime" : `base=${session.rtc},clock=vm`,
    "-audiodev",
    settings
      ? `${process.platform === "darwin" ? "coreaudio" : "sdl3"},id=snd0`
      : "none,id=snd0",
    "-global",
    "gnw-h7b0-sai1.audiodev=snd0",
    "-global",
    "gnw-h7b0-rtc.use-rtc-clock=on",
    "-global",
    "gnw-h7b0-rtc.preserve-calendar=on",
    "-global",
    "gnw-h7b0-rtc.sync-host=off",
  ];
  if (endpoints.gdbSocket)
    args.push(
      "-gdb",
      `unix:${qemuEscape(endpoints.gdbSocket)},server=on,wait=off`,
    );
  if (settings)
    args.push(
      "-global",
      `gnw-h7b0-sai1.audio-muted=${settings.audio ? "off" : "on"}`,
    );
  // Upstream's custom RTC uses this property rather than QEMU's -rtc base.
  if (session.rtc !== "host") {
    const epoch = Date.parse(session.rtc + "Z") / 1000;
    if (!Number.isInteger(epoch) || epoch < 0)
      throw new Error("gwemu RTC requires a nonnegative UTC epoch");
    args.push("-global", `gnw-h7b0-rtc.initial-epoch=${epoch}`);
  }
  for (const [property, value] of [
    ["bank1-image", session.internalFlash],
    ["bank2-image", session.bank2Flash],
    ["extflash-image", session.externalFlash],
    ["extflash-chip", chip],
    ["uid", profile.deviceUid],
  ])
    if (value)
      // The shorthand -global parser preserves everything after '=' literally.
      args.push("-global", `gnw-h7b0-soc.${property}=${value}`);
  if (session.sdCard)
    args.push("-drive", `if=sd,format=raw,file=${qemuEscape(session.sdCard)}`);
  return args;
}
