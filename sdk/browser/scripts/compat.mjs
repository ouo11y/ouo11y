// Checks of the built bundle (checklist N42), the second half of `npm run compat:check` after
// es-check:
//   - both entries import in plain Node (no window, no document) and initRUM there is inert,
//     which is what server rendering (Next.js, Remix) does;
//   - every dist/*.js.map maps the minified code back to its source: a known string in each file
//     resolves to the right source file (a map from before minification maps nothing).
import { readdirSync, readFileSync } from "node:fs";
import { SourceMapConsumer } from "source-map";

/** File pattern -> a string literal in it and the source file that must contain it. */
const KNOWN = [
  [/^index\.js$/, "ouo.replay.skipped", /src\/index\.ts$/],
  [/^react\.js$/, "react.error_boundary", /src\/react\/index\.ts$/],
  [/^rrweb-.*\.js$/, "takeFullSnapshot", /rrweb/],
];
for (const file of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  const [, needle, source] = KNOWN.find(([re]) => re.test(file)) ?? [];
  if (!needle) throw new Error(`no source-map probe for dist/${file}`);
  const code = readFileSync(`dist/${file}`, "utf8").split("\n");
  const line = code.findIndex((l) => l.includes(needle));
  const column = code[line].indexOf(needle);
  const map = JSON.parse(readFileSync(`dist/${file}.map`, "utf8"));
  const pos = await SourceMapConsumer.with(map, null, (c) => c.originalPositionFor({ line: line + 1, column, bias: SourceMapConsumer.LEAST_UPPER_BOUND }));
  if (!pos.source || !source.test(pos.source)) throw new Error(`dist/${file}.map: "${needle}" at ${line + 1}:${column} maps to ${pos.source}:${pos.line}, expected ${source}`);
  console.log(`ok: dist/${file}.map maps ${line + 1}:${column} to ${pos.source}:${pos.line}`);
}
if (typeof globalThis.window !== "undefined" || typeof globalThis.document !== "undefined") throw new Error("expected a Node global scope");
const core = await import("../dist/index.js");
await import("../dist/react.js");
const rum = core.initRUM({ endpoint: "http://localhost:4318", projectId: "p", projectToken: "t", service: { name: "ssr", version: "1", environment: "ci" } });
if (rum.session.id() !== "" || core.getRUM() !== undefined) throw new Error("initRUM is not inert on the server");
await rum.flush();
await rum.shutdown();
console.log("ok: entries import in Node and initRUM is inert there");
