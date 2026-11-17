// Gating npm audit (security.yml, job npm-audit): fails on any advisory of severity high or
// critical in the runtime dependencies, except the advisory IDs listed in IGNORED.
//
//   npm audit --omit=dev --json | node .github/scripts/npm-audit-gate.mjs
//
// Every advisory appears as an object in the `via` list of the package it affects; the
// dependents that only inherit it list package names (strings) instead. So the gate checks the
// advisory objects only, and an ignored advisory cannot hide any other one.
//
// IGNORED holds only advisories that have no patched release. Each entry says when it was added
// and when to drop it. Add one only with the founder's approval.
const IGNORED = {
  // 2026-11-18: picomatch ReDoS, vulnerable <= 4.0.7 (every release), no patched version.
  // Reached only through @grafana/i18n -> @typescript-eslint/utils -> typescript-estree ->
  // tinyglobby (lint-time code, not in the plugin bundle). Drop this entry as soon as picomatch
  // ships a fix: `npm view picomatch version` above 4.0.7, or the advisory lists a patched version.
  'GHSA-fc5q-39xc-vjpf': 'picomatch ReDoS, no patched release',
};
const GATING = new Set(['high', 'critical']);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const report = JSON.parse(input);
if (report.error) {
  console.error(`npm audit failed: ${JSON.stringify(report.error)}`);
  process.exit(1);
}
if (report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object' || !report.vulnerabilities) {
  console.error('npm audit output is not an auditReportVersion 2 report; refusing to pass');
  process.exit(1);
}

const failing = [];
const ignored = [];
for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via === 'string' || !GATING.has(via.severity)) continue;
    const id = via.url?.split('/').pop();
    (Object.hasOwn(IGNORED, id) ? ignored : failing).push(`${pkg} ${via.severity} ${id}: ${via.title}`);
  }
}
for (const line of ignored) console.log(`ignored: ${line}`);
for (const line of failing) console.log(`::error::${line}`);
if (failing.length) process.exit(1);
console.log('no high or critical advisory in runtime dependencies (outside the ignore list)');
