import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "native-parent-guardian",
        closeBundle() {
          copyFileSync(
            resolve("src/core/native-guardian.cjs"),
            resolve("out/main/native-guardian.cjs"),
          );
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          utility: resolve("src/display/utility.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    build: {
      minify: "esbuild",
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
  },
});
