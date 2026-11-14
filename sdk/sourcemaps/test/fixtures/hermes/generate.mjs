#!/usr/bin/env node
// Regenerates the Hermes fixture of test/react-native.test.ts: two OTA bundles of one store version,
// built the way a React Native release build makes them.
//
//   1. Metro: `expo export:embed`, what Expo's Gradle and Xcode builds run, with the app's
//      metro.config.js, which adds ouoExpoDebugIdPlugin from @ouo11y/sourcemaps/metro
//      (export:embed ignores --config: it always loads the project's own),
//   2. hermesc -O -emit-binary -output-source-map (the Hermes that React Native ships),
//   3. ouo-sourcemaps compose (Metro's map + hermesc's map = the map of the bytecode).
//
// It writes v1/ and v2/ (index.android.bundle.hbc, index.android.bundle.hbc.map) and
// expected.json: each bundle's debug id and the bytecode offset of the `// @throw` and `// @call`
// lines, read from the composed map (the first offset mapped to the line, the start of an
// instruction, which is what Hermes prints as the column of an "address at" frame).
//
// Needs sdk/sourcemaps built (npm ci at the root, npm run build -w @ouo11y/sourcemaps) and
// `npm ci` in the React Native app (default examples/ouo-mobile, override with RN_PROJECT):
//
//   node sdk/sourcemaps/test/fixtures/hermes/generate.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../..");
const rn = path.resolve(process.env.RN_PROJECT ?? path.join(repo, "examples/ouo-mobile"));
const cli = path.join(repo, "sdk/sourcemaps/dist/cli.js");
const metroPlugin = path.join(repo, "sdk/sourcemaps/dist/metro.cjs");
const bin = { darwin: "osx-bin", linux: "linux64-bin", win32: "win64-bin" }[process.platform];
const hermesc = process.env.HERMESC ?? path.join(rn, "node_modules/hermes-compiler/hermesc", bin, process.platform === "win32" ? "hermesc.exe" : "hermesc");
for (const f of [cli, metroPlugin, hermesc, path.join(rn, "node_modules/expo")]) statSync(f);

// Metro only bundles files under the project's watch folders: build from a folder inside it.
const work = path.join(rn, "ouo-hermes-fixture-tmp");
const run = (cmd, args, cwd = rn) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();

const expected = {};
try {
  for (const v of ["v1", "v2"]) {
    const dir = path.join(work, v);
    const out = path.join(dir, "out");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(path.join(here, "src", v, "index.js"), path.join(dir, "index.js"));
    const bundle = path.join(out, "index.android.bundle");
    run(path.join(rn, "node_modules/.bin/expo"), [
      "export:embed", "--platform", "android", "--dev", "false", "--minify", "false", "--reset-cache",
      "--entry-file", path.relative(rn, path.join(dir, "index.js")),
      "--bundle-output", bundle, "--sourcemap-output", `${bundle}.map`, "--assets-dest", out,
    ]);
    if (!readFileSync(bundle, "utf8").includes("ouo-debug-id:")) throw new Error(`${bundle}: no ouo debug id snippet (is ouoExpoDebugIdPlugin in ${rn}/metro.config.js?)`);
    run(hermesc, ["-O", "-emit-binary", "-output-source-map", "-out", `${bundle}.hbc`, bundle]);
    run("node", [cli, "compose", `${bundle}.map`, `${bundle}.hbc.map`, "-o", `${bundle}.composed.map`, "--bundle", `${bundle}.hbc`]);

    const map = JSON.parse(readFileSync(`${bundle}.composed.map`, "utf8"));
    // Keep the fixture small: only the app's own source content (Metro's polyfills are mapped too).
    map.sourcesContent = map.sources.map((s, i) => (s.endsWith(`${v}/index.js`) ? map.sourcesContent?.[i] ?? null : null));
    map.sources = map.sources.map((s) => (s.endsWith(`${v}/index.js`) ? `src/${v}/index.js` : s.replace(/^(?:\.\.\/)+/, "")));
    const dest = path.join(here, v);
    mkdirSync(dest, { recursive: true });
    cpSync(`${bundle}.hbc`, path.join(dest, "index.android.bundle.hbc"));
    writeFileSync(path.join(dest, "index.android.bundle.hbc.map"), JSON.stringify(map));

    const src = readFileSync(path.join(here, "src", v, "index.js"), "utf8").split("\n");
    const lineOf = (tag) => src.findIndex((l) => l.includes(tag)) + 1;
    const app = map.sources.indexOf(`src/${v}/index.js`);
    const offsetOf = (line) => decode(map.mappings).find((m) => m.source === app && m.line === line - 1)?.column;
    expected[v] = {
      debug_id: map.debugId,
      throw: { line: lineOf("// @throw"), column: offsetOf(lineOf("// @throw")) },
      call: { line: lineOf("// @call"), column: offsetOf(lineOf("// @call")) },
    };
  }
  writeFileSync(path.join(here, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  process.stdout.write(JSON.stringify(expected, null, 2) + "\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Source map "mappings" -> segments of line 0 (a Hermes map has one generated line), sorted by
// generated column: { column, source, line } with 0-based original lines.
function decode(mappings) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  let col = 0, source = 0, line = 0, ocol = 0;
  for (const seg of mappings.split(";")[0].split(",")) {
    if (!seg) continue;
    const v = [];
    let shift = 0, value = 0;
    for (const ch of seg) {
      const d = B64.indexOf(ch);
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        v.push(value & 1 ? -(value >>> 1) : value >>> 1);
        shift = value = 0;
      }
    }
    col += v[0];
    if (v.length >= 4) {
      source += v[1];
      line += v[2];
      ocol += v[3];
      out.push({ column: col, source, line });
    }
  }
  return out.sort((a, b) => a.column - b.column);
}
