import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "browser",
  target: "es2022",
  dts: true,
  sourcemap: true,
  splitting: true,
  clean: true,
  treeshake: true,
  minify: true,
  // Everything is bundled so the consumer gets one entry plus a lazily loaded rrweb chunk.
  noExternal: [/.*/],
  outDir: "dist",
});
