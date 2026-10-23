import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", react: "src/react/index.ts" },
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
  // The React entry keeps React (a peer dependency) and the SDK itself external, so it shares
  // the app's React and the one `initRUM` instance.
  noExternal: [/^(?!react$|react\/|@ouo11y\/browser$).*/],
  external: ["react", "@ouo11y/browser"],
  outDir: "dist",
});
