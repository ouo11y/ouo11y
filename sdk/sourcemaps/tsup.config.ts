import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    target: "node24",
    dts: { entry: { index: "src/index.ts" } },
    clean: true,
    outDir: "dist",
  },
  // metro.config.js and hot-updater.config.ts load these: CommonJS and ESM, and an older Node
  // than the CLI's, since a React Native toolchain may still run Node 20.
  {
    entry: { metro: "src/metro.ts", "hot-updater": "src/hot-updater.ts" },
    format: ["esm", "cjs"],
    platform: "node",
    target: "node20",
    dts: true,
    outDir: "dist",
  },
]);
