import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  // CommonJS: Metro consumes it natively and the guarded `require` fallbacks stay plain calls.
  format: ["cjs"],
  // `browser` selects the OTel browser builds (fetch transport, Math.random ids, performance clock),
  // which are the builds that run on Hermes. Node builds would pull node:http.
  platform: "browser",
  target: "es2020",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // Bundle every OTel package so Metro never has to resolve their `browser` field remaps.
  noExternal: [/^@opentelemetry\//],
  external: ["react", "react-native", "@react-native-async-storage/async-storage", "promise/setimmediate/rejection-tracking"],
  outDir: "dist",
});
