import { expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProfile } from "../../src/core/profile-store";
import { compareKernels } from "../../tools/kernel-comparison";
import * as sessionStore from "../../src/core/session-store";
const nativeGwemu = resolve(
  process.env.GWEMU_BINARY ?? "../build/gwemu/qemu-system-arm",
);

test("failed launches preserve source images and leave two independent diagnostic sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-compare-test-"));
  try {
    const internal = join(root, "internal.bin"),
      external = join(root, "external.bin");
    await writeFile(internal, Buffer.alloc(128 * 1024, 0x91));
    await writeFile(external, Buffer.alloc(1024 * 1024, 0x37));
    const profile = await createProfile(join(root, "test.gnw.json"), {
      model: "mario",
      internalFlash: internal,
      externalFlash: external,
    });
    const before = await readFile(internal);
    const output = join(root, "new-results");
    const report = await compareKernels({
      profilePath: profile.path,
      legacy: "/usr/bin/false",
      gwemu: "/usr/bin/false",
      outputDirectory: output,
      seconds: 0.05,
    });
    expect(report.sourceUnchanged).toBe(true);
    expect(await readFile(internal)).toEqual(before);
    expect(report.runs.map((run) => run.status)).toEqual(["failed", "failed"]);
    expect(report.runs[0].sessionDirectory).not.toBe(
      report.runs[1].sessionDirectory,
    );
    for (const run of report.runs) {
      expect(await readFile(join(run.sessionDirectory, "bank1.bin"))).toEqual(
        before,
      );
      expect(run.args?.join(" ")).not.toContain(internal);
      expect(run.error).toBeTruthy();
    }
    expect(
      JSON.parse(await readFile(join(output, "report.json"), "utf8"))
        .sourceUnchanged,
    ).toBe(true);
    await expect(
      compareKernels({
        profilePath: profile.path,
        legacy: "/usr/bin/false",
        gwemu: "/usr/bin/false",
        outputDirectory: output,
        seconds: 0.05,
      }),
    ).rejects.toThrow(/exist/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("invalid profile and observation time fail before creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-compare-invalid-"));
  try {
    const options = {
      profilePath: resolve(root, "missing.gnw.json"),
      legacy: "/usr/bin/false",
      gwemu: "/usr/bin/false",
      outputDirectory: join(root, "output"),
      seconds: NaN,
    };
    await expect(compareKernels(options)).rejects.toThrow(/seconds/);
    await expect(compareKernels({ ...options, seconds: 1 })).rejects.toThrow();
    await expect(
      readFile(join(root, "output", "report.json")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown input chord is refused before reading images or starting a kernel", async () => {
  await expect(
    compareKernels({
      profilePath: "/missing.gnw.json",
      legacy: "/usr/bin/false",
      gwemu: "/usr/bin/false",
      outputDirectory: "/missing-output",
      seconds: 3,
      buttons: "left+unknown",
    }),
  ).rejects.toThrow(/button/);
});

test("a session preparation failure still writes a report and verifies source hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-copy-failure-"));
  const failure = vi
    .spyOn(sessionStore, "prepareSession")
    .mockRejectedValueOnce(new Error("copy failed"));
  try {
    const internal = join(root, "internal.bin"),
      external = join(root, "external.bin");
    await writeFile(internal, Buffer.alloc(128 * 1024));
    await writeFile(external, Buffer.alloc(1024 * 1024));
    const profile = await createProfile(join(root, "test.gnw.json"), {
      model: "mario",
      internalFlash: internal,
      externalFlash: external,
    });
    const report = await compareKernels({
      profilePath: profile.path,
      legacy: "/usr/bin/false",
      gwemu: "/usr/bin/false",
      outputDirectory: join(root, "result"),
      seconds: 0.05,
    });
    expect(report.sourceUnchanged).toBe(true);
    expect(report.runs[0].status).toBe("failed");
    expect(report.runs[0].error).toContain("session.prepare");
    expect(
      JSON.parse(await readFile(join(root, "result", "report.json"), "utf8"))
        .runs,
    ).toHaveLength(2);
  } finally {
    failure.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync(nativeGwemu))(
  "real gwemu loads seeded vectors from a comma path and ignores ambient automation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gnw-real-comma-"));
    const saved = {
      timeline: process.env.GNW_TIMELINE,
      out: process.env.GNW_OUT,
    };
    try {
      const internal = Buffer.alloc(128 * 1024, 0xff);
      internal.writeUInt32LE(0x20020000, 0);
      internal.writeUInt32LE(0x08000009, 4);
      internal[8] = 0xfe;
      internal[9] = 0xe7; // Thumb branch to itself.
      await writeFile(join(root, "internal.bin"), internal);
      await writeFile(
        join(root, "external.bin"),
        Buffer.alloc(1024 * 1024, 0x37),
      );
      const profile = await createProfile(join(root, "test.gnw.json"), {
        model: "mario",
        internalFlash: join(root, "internal.bin"),
        externalFlash: join(root, "external.bin"),
      });
      process.env.GNW_TIMELINE = join(root, "missing-timeline");
      process.env.GNW_OUT = join(root, "unexpected");
      const report = await compareKernels({
        profilePath: profile.path,
        legacy: "/usr/bin/false",
        gwemu: nativeGwemu,
        outputDirectory: join(root, "results, comma"),
        seconds: 0.05,
      });
      expect(report.runs[1].status).toBe("captured");
      expect(report.runs[1].observations.vectors).toBe(
        internal.subarray(0, 32).toString("hex"),
      );
      expect(String(report.runs[1].observations.rtcRegisters).slice(0, 8)).toBe(
        "00000900",
      );
      expect(report.sourceUnchanged).toBe(true);
      expect(existsSync(join(root, "unexpected"))).toBe(false);
    } finally {
      if (saved.timeline === undefined) delete process.env.GNW_TIMELINE;
      else process.env.GNW_TIMELINE = saved.timeline;
      if (saved.out === undefined) delete process.env.GNW_OUT;
      else process.env.GNW_OUT = saved.out;
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
