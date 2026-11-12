// Checks of the built bundle, the second half of `npm run compat:check` after es-check:
//   - both entries import in plain Node (no window, no document) and the SDK there is a no-op,
//     which is what server rendering (Next.js, Remix) does (LIF-9);
//   - the files a page loads at once do not contain the replay engine or rrweb;
//   - every dist/*.js.map maps the minified code back to its source: a known string in each file
//     resolves to the right source file (a map from before minification maps nothing).
import { readdirSync, readFileSync } from "node:fs";
import { SourceMapConsumer } from "source-map";

/** File pattern -> a string literal in it and the source file that must contain it. */
const KNOWN = [
  [/^index\.js$/, "ouo.sdk.disabled", /src\/index\.ts$/],
  [/^react\.js$/, "ouo.react.component_stack", /src\/react\/index\.ts$/],
  [/^engine-.*\.js$/, "ouo.replay.sha256", /src\/replay\/engine\.ts$/],
  [/^structure-.*\.js$/, "takeFullSnapshot", /rrweb|src\/replay\/structure\.ts$/],
  [/^pixel-.*\.js$/, "foreignObject", /src\/replay\/pixel\.ts$/],
  // Shared chunks: any mapping is enough.
  [/^chunk-.*\.js$/, null, /./],
];
for (const file of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  const probe = KNOWN.find(([re]) => re.test(file));
  if (!probe) throw new Error(`no source-map probe for dist/${file}`);
  const [, needle, source] = probe;
  if (needle === null) continue;
  const code = readFileSync(`dist/${file}`, "utf8").split("\n");
  const line = code.findIndex((l) => l.includes(needle));
  const column = code[line].indexOf(needle);
  const map = JSON.parse(readFileSync(`dist/${file}.map`, "utf8"));
  const pos = await SourceMapConsumer.with(map, null, (c) => c.originalPositionFor({ line: line + 1, column, bias: SourceMapConsumer.LEAST_UPPER_BOUND }));
  if (!pos.source || !source.test(pos.source)) throw new Error(`dist/${file}.map: "${needle}" at ${line + 1}:${column} maps to ${pos.source}:${pos.line}, expected ${source}`);
  console.log(`ok: dist/${file}.map maps ${line + 1}:${column} to ${pos.source}:${pos.line}`);
}
if (typeof globalThis.window !== "undefined" || typeof globalThis.document !== "undefined") throw new Error("expected a Node global scope");
// What a page loads at once: the entry and the chunks it imports statically.
const eager = ["index.js", ...[...readFileSync("dist/index.js", "utf8").matchAll(/from\s*"\.\/(chunk-[^"]+\.js)"/g)].map((m) => m[1])];
for (const file of eager) {
  const code = readFileSync(`dist/${file}`, "utf8");
  for (const lazy of ["takeFullSnapshot", "ouo.replay.sha256", "foreignObject"]) if (code.includes(lazy)) throw new Error(`dist/${file} is loaded at once but contains replay code ("${lazy}")`);
}
console.log(`ok: replay is not in the files loaded at once (${eager.join(", ")})`);
const core = await import("../dist/index.js");
await import("../dist/react.js");
core.init({ endpoint: "http://localhost:4318", serviceName: "ssr" });
core.recordEvent("x");
core.recordException(new Error("x"));
if (core.getSessionId() !== undefined || core.diagnostics().state !== "off") throw new Error("the SDK is not a no-op on the server");
await core.flush();
await core.shutdown();
console.log("ok: entries import in Node and the SDK is a no-op there");
