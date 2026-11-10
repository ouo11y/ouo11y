// Bundles the React Native SDKs' JavaScript the way Metro would include it (esbuild here: minified
// ESM, react-native/react/expo packages external) and writes raw, gzip-9 and brotli-11 sizes to
// results/rn-bundle.json. Native code is not included.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
const ext = ["react", "react-native", "react/jsx-runtime", "expo-modules-core", "expo-constants", "expo", "@react-native-async-storage/async-storage", "react-native-*", "@react-native/*", "expo-*", "promise/*"];
const pkg = (n) => JSON.parse(readFileSync(`node_modules/${n}/package.json`, "utf8")).version;
const out = { method: "esbuild bundle of the package entry (own folder, so only one Sentry core resolves), minified ESM, React Native and Expo packages external, gzip -9 and brotli 11" };
mkdirSync("results", { recursive: true });
for (const [key, entry, name] of [["ouo", "rn-entries/e-ouo.js", "@ouo11y/react-native"], ["sentry", "rn-entries/e-sentry.js", "@sentry/react-native"]]) {
  await build({ entryPoints: [entry], bundle: true, minify: true, format: "esm", outfile: `dist/rn-${key}.js`, platform: "neutral", mainFields: ["react-native", "module", "main"], conditions: ["react-native", "import", "require", "default"], external: ext, logLevel: "error", define: { __DEV__: "false", "process.env.NODE_ENV": '"production"' }, resolveExtensions: [".native.js", ".ios.js", ".js", ".mjs", ".cjs", ".json"], loader: { ".js": "jsx" } });
  const b = readFileSync(`dist/rn-${key}.js`);
  out[key] = { package: `${name} ${pkg(name)}`, raw_kib: +(b.length / 1024).toFixed(1), gz_kib: +(gzipSync(b, { level: 9 }).length / 1024).toFixed(1), br_kib: +(brotliCompressSync(b).length / 1024).toFixed(1) };
  console.log(key, out[key]);
}
writeFileSync("results/rn-bundle.json", JSON.stringify(out, null, 1));
