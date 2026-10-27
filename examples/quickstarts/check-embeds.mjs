#!/usr/bin/env node
// Keeps files embedded in the quickstart guides identical to their source in the repo.
//
// Covers the web quickstarts (this folder) and the mobile ones (../quickstarts-mobile).
//
// A guide embeds a repo file as a fenced block right after a marker line:
//
//   <!-- embed: deploy/compose/quickstart.yaml -->
//   ```yaml
//   ...the file, verbatim...
//   ```
//
//   node examples/quickstarts/check-embeds.mjs          fails when a block differs from its file
//   node examples/quickstarts/check-embeds.mjs --write  rewrites the blocks from the files
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const write = process.argv.includes("--write");
const marker = /^<!-- embed: (\S+) -->\n(`{3,})([^\n]*)\n([\s\S]*?)\n\2$/gm;

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    // Dependencies and the generated native projects of the mobile apps hold no guides.
    if (["node_modules", "ios", "android", "Pods"].includes(name) || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

let stale = 0;
const guides = [here, resolve(here, "../quickstarts-mobile")].flatMap(markdownFiles);
for (const guide of guides) {
  const text = readFileSync(guide, "utf8");
  const updated = text.replace(marker, (block, source, fence, lang, body) => {
    const want = readFileSync(join(root, source), "utf8").replace(/\n$/, "");
    if (body === want) return block;
    stale++;
    console.error(`${relative(root, guide)}: embedded ${source} differs from the file`);
    return `<!-- embed: ${source} -->\n${fence}${lang}\n${want}\n${fence}`;
  });
  if (write && updated !== text) writeFileSync(guide, updated);
}

if (stale && !write) {
  console.error("Run: node examples/quickstarts/check-embeds.mjs --write");
  process.exit(1);
}
console.log(stale ? `rewrote ${stale} embedded file(s)` : "embedded files in sync");
