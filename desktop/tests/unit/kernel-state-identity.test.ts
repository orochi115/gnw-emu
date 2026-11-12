import { expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as backend from "../../src/core/kernel-backend";
import { existsSync, createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Profile } from "../../src/core/schemas";
test("runtime identity hashes actual executable and detects replacement before spawn", async () => {
  expect((backend as any).captureKernelIdentity).toBeTypeOf("function");
  const d = await mkdtemp(join(tmpdir(), "gwemu-identity-"));
  try {
    const binary = join(d, "qemu");
    await writeFile(binary, "first executable");
    const identity = await (backend as any).captureKernelIdentity(
      "gwemu",
      binary,
    );
    expect(identity).toEqual({
      kernel: "gwemu",
      buildSha256: createHash("sha256")
        .update("first executable")
        .digest("hex"),
    });
    await (backend as any).verifyKernelIdentity(binary, identity);
    await writeFile(binary, "different executable");
    await expect(
      (backend as any).verifyKernelIdentity(binary, identity),
    ).rejects.toMatchObject({ code: "error.kernelBuild" });
    await rm(binary);
    await expect(
      (backend as any).verifyKernelIdentity(binary, identity),
    ).rejects.toMatchObject({ code: "error.kernelBuild" });
    expect(identity.buildSha256).toBe(
      createHash("sha256").update("first executable").digest("hex"),
    );
    expect(
      await (backend as any).captureKernelIdentity("legacy", "/does-not-exist"),
    ).toEqual({ kernel: "legacy" });
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
const native =
  process.env.GWEMU_BINARY ??
  join(process.cwd(), "../build/gwemu-session-manager-release/qemu-system-arm");
test.skipIf(!existsSync(native))(
  "real preflight proves snapshot access without changing source images and captures actual build",
  async () => {
    const d = await mkdtemp(join(tmpdir(), "gwemu-real-preflight-"));
    try {
      const internalFlash = join(d, "bank1.bin"),
        externalFlash = join(d, "external.bin");
      const bank = Buffer.alloc(128 * 1024, 0x37),
        flash = Buffer.alloc(1024 * 1024, 0x59);
      await writeFile(internalFlash, bank);
      await writeFile(externalFlash, flash);
      const identity = await backend.preflightKernel(
        "gwemu",
        { internalFlash, externalFlash } as Profile,
        native,
      );
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(native)) hash.update(bytes);
      expect(identity).toEqual({
        kernel: "gwemu",
        buildSha256: hash.digest("hex"),
      });
      expect(await readFile(internalFlash)).toEqual(bank);
      expect(await readFile(externalFlash)).toEqual(flash);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  },
);
