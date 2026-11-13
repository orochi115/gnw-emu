import { expect, test } from "vitest";
import { join, resolve } from "node:path";
import { applicationPaths } from "../../src/core/paths";
const base = {
  packaged: false,
  resources: "/app/resources",
  project: "/app/project",
  osUserData: "/app/os",
};
test("development defaults to gwemu and normal product data", () => {
  expect(applicationPaths(base)).toEqual({
    kernel: "gwemu",
    userData: join(base.project, "UserData"),
    qemu: join(
      base.project,
      "build",
      "gwemu",
      process.platform === "win32" ? "qemu-system-arm.exe" : "qemu-system-arm",
    ),
  });
});
test("packaged gwemu uses staged native binary and OS product data", () => {
  expect(
    applicationPaths({ ...base, packaged: true, kernel: "gwemu" }),
  ).toEqual({
    kernel: "gwemu",
    userData: join(base.osUserData, "UserData"),
    qemu: join(
      base.resources,
      "qemu",
      process.platform === "win32" ? "qemu-system-arm.exe" : "qemu-system-arm",
    ),
  });
});
test("explicit data overrides are accepted without preview isolation", () => {
  expect(
    applicationPaths({
      ...base,
      kernel: "gwemu",
      override: join(base.project, "UserData", "child"),
    }).userData,
  ).toBe(resolve(base.project, "UserData", "child"));
});
test("retired legacy and unknown selection fail clearly", () => {
  expect(() => applicationPaths({ ...base, kernel: "legacy" })).toThrow(
    /legacy.*retired/i,
  );
  expect(() => applicationPaths({ ...base, kernel: "unknown" })).toThrow(
    /kernel/i,
  );
});
