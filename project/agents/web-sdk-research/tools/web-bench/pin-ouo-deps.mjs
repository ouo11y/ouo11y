// Pins a copy of sdk/browser/package.json to the versions of the repository's package-lock.json, so
// the scratch build of @ouo11y/browser bundles what the repo ships (a fresh resolve of the ^ ranges
// picks newer releases). Direct runtime dependencies become exact versions; every runtime package
// they pull in becomes an `overrides` entry (or an exact devDependency when it is one).
// Usage (in the scratch copy of sdk/browser): node <bench>/pin-ouo-deps.mjs <repo>/package-lock.json
import { readFileSync, writeFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(process.argv[2], "utf8")).packages;
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const find = (name) => lock[`sdk/browser/node_modules/${name}`] ?? lock[`node_modules/${name}`];

const overrides = {};
const seen = new Set();
const walk = (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  const entry = find(name);
  if (!entry) return;
  // npm refuses an override of a direct (or dev) dependency: pin those in place instead.
  if (name in (pkg.devDependencies ?? {})) pkg.devDependencies[name] = entry.version;
  else if (!(name in pkg.dependencies)) overrides[name] = entry.version;
  for (const dep of Object.keys(entry.dependencies ?? {})) walk(dep);
};
for (const name of Object.keys(pkg.dependencies)) {
  const entry = find(name);
  if (entry) pkg.dependencies[name] = entry.version;
  walk(name);
}
pkg.overrides = overrides;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log(Object.entries(pkg.dependencies).map(([n, v]) => `${n}@${v}`).join("\n"));
console.log(`${Object.keys(overrides).length} transitive packages pinned through overrides`);
