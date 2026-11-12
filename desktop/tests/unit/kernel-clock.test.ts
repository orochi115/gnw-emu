import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { kernelArguments } from "../../src/core/kernel-backend";
import type { Profile } from "../../src/core/schemas";
import type { Session } from "../../src/core/session-store";

test.each([true, false])(
  "realtime selects legacy pacing; gwemu keeps plain TCG (audio=%s)",
  async (audio) => {
    const directory = await mkdtemp(join(tmpdir(), "gnw-clock-"));
    try {
      const internalFlash = join(directory, "bank1.bin");
      const externalFlash = join(directory, "flash.bin");
      await writeFile(internalFlash, Buffer.alloc(128 * 1024, 255));
      await writeFile(externalFlash, Buffer.alloc(1024 * 1024, 255));
      const profile: Profile = {
        path: join(directory, "clock.gnw.json"),
        formatVersion: 1,
        id: "11111111-1111-4111-8111-111111111111",
        model: "mario",
        internalFlash,
        externalFlash,
      };
      const session: Session = {
        formatVersion: 1,
        directory,
        internalFlash,
        externalFlash,
        battery: 100,
        usbPower: false,
        rtc: "host",
        batteryLifeMinutes: 480,
        chargeTimeMinutes: 180,
      };
      const endpoints = {
        qmpPort: 1234,
        framePort: 4321,
        stateFile: join(directory, "state.json"),
      };
      const args = async (kind: "legacy" | "gwemu", realtime: boolean) =>
        kernelArguments(kind, profile, session, { audio, realtime }, endpoints);
      const on = await args("legacy", true);
      const off = await args("legacy", false);
      expect(on[on.indexOf("-M") + 1]).toContain("realtime=on");
      expect(on[on.indexOf("-icount") + 1]).toBe("shift=2,sleep=off");
      expect(off[off.indexOf("-M") + 1]).toContain("realtime=off");
      expect(off).not.toContain("-icount");
      for (const legacy of [on, off])
        expect(legacy[legacy.indexOf("-M") + 1]).toContain(
          `audio=on,audio-muted=${audio ? "off" : "on"}`,
        );
      const candidate = await args("gwemu", true);
      expect(await args("gwemu", false)).toEqual(candidate);
      expect(candidate).not.toContain("-icount");
      expect(candidate[candidate.indexOf("-M") + 1]).not.toContain("realtime=");
      expect(candidate).toContain(
        `gnw-h7b0-sai1.audio-muted=${audio ? "off" : "on"}`,
      );
      expect(candidate).not.toContain("none,id=snd0");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
