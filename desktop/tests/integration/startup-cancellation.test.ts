import { test, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import * as kernel from "../../src/core/kernel-backend";
import { SessionController } from "../../src/core/session-controller";
import { createProfile } from "../../src/core/profile-store";
import { createDisplayReceiver } from "../../src/display/receiver";
import { createLogManager } from "../../src/observability/logger";

test("stop waits for an interrupted startup to release its resources and prevents a later spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "gnw-start-cancel-"));
  let entered!: () => void, resume!: () => void;
  const preparing = new Promise<void>((r) => (entered = r));
  const paused = new Promise<void>((r) => (resume = r));
  const args = vi
    .spyOn(kernel, "kernelArguments")
    .mockImplementation(async () => {
      entered();
      await paused;
      return [];
    });
  const controller = new SessionController({
    qemu: resolve(
      process.env.GWEMU_DESKTOP_BINARY ??
        "../build/gwemu/qemu-system-arm",
    ),
    userData: join(root, "data"),
    logger: createLogManager({
      appInstanceId: "cancel",
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }).child("session"),
    createDisplay: () => createDisplayReceiver(() => {}),
  });
  let loading: Promise<void> | undefined, stopping: Promise<void> | undefined;
  try {
    await writeFile(join(root, "internal.bin"), Buffer.alloc(128 * 1024));
    await writeFile(join(root, "external.bin"), Buffer.alloc(1024 * 1024));
    const profile = await createProfile(join(root, "test.gnw.json"), {
      model: "mario",
      internalFlash: join(root, "internal.bin"),
      externalFlash: join(root, "external.bin"),
    });
    loading = controller.load(profile.path);
    loading.catch(() => {});
    await preparing;
    let stopped = false;
    stopping = controller.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    resume();
    await expect(loading).rejects.toThrow("error.startCancelled");
    await stopping;
    expect(controller.state.status).toBe("idle");
    expect(controller.diagnostics().qemuPid).toBeUndefined();
    // Resources are truly reusable after cancellation.
    const { acquireLease } = await import("../../src/core/session-lease");
    const lease = await acquireLease(
      join(root, "data", "kernels", "gwemu", "leases", profile.id),
      "after-cancel",
    );
    await lease.release();
  } finally {
    resume();
    await loading?.catch(() => {});
    await stopping?.catch(() => {});
    await controller.stop().catch(() => {});
    args.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
