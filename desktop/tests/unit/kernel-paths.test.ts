import { expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applicationPaths } from "../../src/core/paths";

test("gwemu requires an explicit isolated development directory and its own binary", () => {
  const root = mkdtempSync(join(tmpdir(), "gnw-kernel-paths-"));
  const base = {
    packaged: false,
    resources: join(root, "resources"),
    project: root,
    osUserData: join(root, "os"),
    kernel: "gwemu",
  };
  try {
    expect(() => applicationPaths(base)).toThrow(/isolated/i);
    expect(() =>
      applicationPaths({ ...base, override: join(root, "UserData", "child") }),
    ).toThrow(/isolated/i);
    expect(() =>
      applicationPaths({
        ...base,
        override: join(root, "UserData", "..preview"),
      }),
    ).toThrow(/isolated/i);
    expect(() =>
      applicationPaths({
        ...base,
        packaged: true,
        override: join(root, "preview"),
      }),
    ).toThrow(/development/i);
    expect(() =>
      applicationPaths({
        ...base,
        kernel: "unknown",
        override: join(root, "preview"),
      }),
    ).toThrow(/kernel/i);
    const paths = applicationPaths({
      ...base,
      override: join(root, "preview"),
    });
    expect(paths.kernel).toBe("gwemu");
    expect(paths.qemu).toBe(
      join(root, "build", "gwemu-softspi", "qemu-system-arm"),
    );
    expect(existsSync(paths.userData)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an alias of protected data is refused even for a nonexistent descendant", () => {
  const root = mkdtempSync(join(tmpdir(), "gnw-kernel-alias-"));
  try {
    mkdirSync(join(root, "UserData"));
    symlinkSync(join(root, "UserData"), join(root, "alias"));
    const options = {
      packaged: false,
      resources: root,
      project: root,
      osUserData: root,
      kernel: "gwemu",
      override: join(root, "alias", "new"),
    };
    expect(() => applicationPaths(options)).toThrow(/isolated/i);
    expect(existsSync(join(root, "alias", "new"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
