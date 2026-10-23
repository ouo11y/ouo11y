#!/usr/bin/env node
// Checks docs/compatibility.md against the release-please manifest, the replay schema
// constants in the code and the Helm chart defaults. Run by release-check.yml on release PRs;
// locally: `node .github/scripts/compat-check.mjs` from the repo root (Node 24, no dependencies).
// Exits 1 with one line per problem.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const read = (p) => readFileSync(p, "utf8");
const problems = [];
const fail = (msg) => problems.push(msg);

// manifest path -> component name (release-please config, `component`)
const config = JSON.parse(read(".github/release-please/config.json"));
const manifest = JSON.parse(read(".github/release-please/manifest.json"));
const versions = {};
for (const [path, pkg] of Object.entries(config.packages)) {
  if (!(path in manifest)) fail(`${path}: in config.json but not in manifest.json`);
  versions[pkg.component] = manifest[path];
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return m.slice(1, 4).map(Number);
};
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const line = (v) => parse(v).slice(0, 2).join(".");

const md = read("docs/compatibility.md");
// Markdown table that follows `<!-- compat:<name> -->`, as row objects keyed by header.
function tableAt(name) {
  const at = md.indexOf(`<!-- compat:${name} -->`);
  if (at < 0) throw new Error(`docs/compatibility.md: marker compat:${name} missing`);
  const lines = md.slice(at).split("\n").slice(1);
  const rows = [];
  for (const l of lines) {
    if (l.startsWith("|")) rows.push(l);
    else if (rows.length) break;
  }
  const cells = (l) => l.slice(1, -1).split("|").map((c) => c.trim());
  const [head, , ...body] = rows;
  const keys = cells(head);
  return body.map((l) => Object.fromEntries(cells(l).map((c, i) => [keys[i], c])));
}

// 1. Every component's current line has a row; bounds point at existing versions.
const lines = tableAt("lines");
const needCols = { "Needs collector": "collector", "Needs rum-api": "rum-api", "Needs plugin": "plugin" };
for (const [component, version] of Object.entries(versions)) {
  const row = lines.find((r) => r.Component === component && r.Line === line(version));
  if (!row) {
    fail(`${component} ${version}: no "${component} | ${line(version)}" row in docs/compatibility.md (add the line and what it needs)`);
  }
}
for (const row of lines) {
  if (!(row.Component in versions)) fail(`docs/compatibility.md: unknown component "${row.Component}"`);
  for (const [col, dep] of Object.entries(needCols)) {
    const cell = row[col] ?? "-";
    if (cell === "-") continue;
    const m = /^>=\s*(\S+)$/.exec(cell);
    if (!m) { fail(`${row.Component} ${row.Line}: "${col}" must be "-" or ">= x.y.z", got "${cell}"`); continue; }
    if (cmp(m[1], versions[dep]) > 0) {
      fail(`${row.Component} ${row.Line}: needs ${dep} ${cell} but ${dep} is at ${versions[dep]}`);
    }
  }
}

// 2. Replay schema_version in the doc equals the code.
const schemaRows = tableAt("schema");
const extract = (file, re) => {
  const m = re.exec(read(file));
  if (!m) { fail(`${file}: could not find the schema_version constant (update compat-check.mjs if it moved)`); return undefined; }
  return Number(m[1]);
};
const code = {
  // parse.go accepts 1..SchemaVersion; the constant lives next to the start-up schema guard (#46).
  "services/rum-api/internal/replay/schema.go": extract("services/rum-api/internal/replay/schema.go", /const SchemaVersion = (\d+)/),
  "collector/receiver/ouoreplayreceiver/chunk.go": extract("collector/receiver/ouoreplayreceiver/chunk.go", /\*schemaVersion != (\d+)/),
  "collector/receiver/ouosentryreceiver/replay.go": extract("collector/receiver/ouosentryreceiver/replay.go", /SchemaVersion:\s*(\d+)/),
  "sdk/ios/Sources/OuoReplayCore/Models.swift": extract("sdk/ios/Sources/OuoReplayCore/Models.swift", /static let schemaVersion = (\d+)/),
};
for (const row of schemaRows) {
  const src = row.Source.replace(/`/g, "");
  if (!(src in code)) { fail(`docs/compatibility.md schema table: unknown source ${src}`); continue; }
  if (code[src] !== undefined && Number(row.schema_version) !== code[src]) {
    fail(`replay schema_version: docs/compatibility.md says ${row.schema_version} for "${row.Where}", ${src} has ${code[src]}`);
  }
}
for (const src of Object.keys(code)) {
  if (!schemaRows.some((r) => r.Source.replace(/`/g, "") === src)) fail(`docs/compatibility.md schema table: no row for ${src}`);
}

// 3. Helm chart defaults point at tagged images.
const values = read("deploy/helm/ouo/values.yaml");
let tags = [];
try {
  tags = execFileSync("git", ["tag", "--list"], { encoding: "utf8" }).split("\n");
} catch {
  fail("git tag --list failed (run from a clone with tags: actions/checkout fetch-depth 0)");
}
for (const image of ["rum-api", "collector", "grafana"]) {
  const m = new RegExp(`repository: ghcr\\.io/ouo11y/${image}\\s*\\n\\s*tag: "?([^"\\s]+)"?`).exec(values);
  if (!m) { fail(`deploy/helm/ouo/values.yaml: no ghcr.io/ouo11y/${image} tag found`); continue; }
  if (tags.length && !tags.includes(`${image}-v${m[1]}`)) {
    fail(`deploy/helm/ouo/values.yaml defaults ${image} to ${m[1]} but tag ${image}-v${m[1]} does not exist`);
  }
}
const appVersion = /^appVersion:\s*"?([^"\s]+)"?/m.exec(read("deploy/helm/ouo/Chart.yaml"))?.[1];
const rumApiDefault = /repository: ghcr\.io\/ouo11y\/rum-api\s*\n\s*tag: "?([^"\s]+)"?/.exec(values)?.[1];
if (appVersion !== rumApiDefault) fail(`Chart.yaml appVersion ${appVersion} != rum-api default tag ${rumApiDefault}`);

// Report.
console.log("component versions (manifest):");
for (const [c, v] of Object.entries(versions)) console.log(`  ${c.padEnd(13)} ${v}`);
console.log(`replay schema_version in code: ${JSON.stringify(Object.values(code))}`);
if (problems.length) {
  console.error(`\n${problems.length} compatibility problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\ncompatibility matrix OK");
