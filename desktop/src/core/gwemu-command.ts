import type { Profile } from "./schemas";
import type { Session } from "./session-store";
import { qemuEscape } from "./qemu-command";

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

/** Migration probe only. This is not the desktop's product launch contract. */
export function gwemuArguments(
  profile: Profile,
  session: Session,
  endpoints: { qmpPort: number; gdbSocket: string },
  sizes: { internalFlash: number; externalFlash: number; bank2Flash?: number },
) {
  if (profile.deviceUid)
    throw new Error(
      "gwemu probe: requested UID is not supported by the pinned upstream",
    );
  if (profile.sdCard && profile.sdWiring === "ospi")
    throw new Error("gwemu probe: OSPI SD wiring has not been adapted");
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
  const args = [
    "-M",
    "gnw-h7b0",
    "-S",
    "-display",
    "none",
    "-qmp",
    `tcp:127.0.0.1:${endpoints.qmpPort},server=off`,
    "-gdb",
    `unix:${qemuEscape(endpoints.gdbSocket)},server=on,wait=off`,
    "-rtc",
    session.rtc === "host" ? "base=localtime" : `base=${session.rtc},clock=vm`,
    "-audiodev",
    "none,id=snd0",
    "-global",
    "gnw-h7b0-sai1.audiodev=snd0",
  ];
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
  ])
    if (value)
      // The shorthand -global parser preserves everything after '=' literally.
      args.push("-global", `gnw-h7b0-soc.${property}=${value}`);
  if (session.sdCard)
    args.push("-drive", `if=sd,format=raw,file=${qemuEscape(session.sdCard)}`);
  return args;
}
