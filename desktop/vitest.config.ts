import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: [
      "tests/integration/kernel-comparison.test.ts",
      "tests/unit/qemu-command.test.ts",
    ],
  },
});
