import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    ...(process.platform === "win32"
      ? { maxWorkers: 2, testTimeout: 30000 }
      : {}),
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: [
      "tests/integration/kernel-comparison.test.ts",
      "tests/unit/qemu-command.test.ts",
      // These fixtures test POSIX socket inodes/modes or executable shebangs.
      // Windows uses ACL/token transport tests and actual native/Electron smoke.
      ...(process.platform === "win32"
        ? [
            "tests/unit/manager-endpoints.test.ts",
            "tests/unit/manager-socket-listener.test.ts",
            "tests/unit/gwemu-state-capabilities.test.ts",
            "tests/integration/manager-controller.test.ts",
            "tests/integration/manager-session-server.test.ts",
            "tests/integration/gwemu-controller.test.ts",
            "tests/integration/gwemu-supply-controller.test.ts",
            "tests/integration/gwemu-savestate-controller.test.ts",
          ]
        : []),
    ],
  },
});
