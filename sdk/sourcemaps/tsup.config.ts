import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  outDir: "dist",
});
