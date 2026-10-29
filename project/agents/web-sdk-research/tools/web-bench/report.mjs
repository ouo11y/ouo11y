// Reads a results JSON from run.mjs (and dist/sizes.json) and prints the Markdown tables of
// benchmark.md: median [q1–q3] per cell, and the paired median delta against `none` (same round).
// Usage: node report.mjs results/main.json[,results/redo.json...] [results/large-dom.json]
// Several main files merge: a (cell, round) run from a later file replaces the earlier one.
import { readFile } from "node:fs/promises";
import { CELLS } from "./cells.mjs";

const [mainPath, largePath] = process.argv.slice(2);
const sizes = JSON.parse(await readFile("dist/sizes.json", "utf8"));

const q = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const med = (xs, d = 0) => `${fmt(q(xs, 0.5), d)} [${fmt(q(xs, 0.25), d)}–${fmt(q(xs, 0.75), d)}]`;
const kb = (b) => b / 1024;

function load(results) {
  const ok = results.runs.filter((r) => r.ok);
  const byCell = {};
  for (const r of ok) (byCell[r.cell] ??= []).push(r);
  const none = Object.fromEntries((byCell.none ?? []).map((r) => [r.round, r]));
  // values of f per run, and paired deltas against none of the same round
  const vals = (cell, f) => (byCell[cell] ?? []).map(f);
  const delta = (cell, f) => (byCell[cell] ?? []).filter((r) => none[r.round]).map((r) => f(r) - f(none[r.round]));
  return { ok, byCell, vals, delta, failed: results.runs.filter((r) => !r.ok) };
}

const row = (cells) => `| ${cells.join(" | ")} |`;
const sep = (n) => row(Array(n).fill("---"));
const order = (cells) => Object.keys(CELLS).filter((c) => cells.includes(c));

const files = await Promise.all(mainPath.split(",").map(async (p) => JSON.parse(await readFile(p, "utf8"))));
const main = { ...files[0], runs: [] };
const latest = new Map();
for (const f of files) for (const r of f.runs) if (r.ok || !latest.get(`${r.cell}/${r.round}`)?.ok) latest.set(`${r.cell}/${r.round}`, r);
main.runs = [...latest.values()];
main.rounds = new Set(main.runs.filter((r) => r.ok).map((r) => r.round)).size;
const M = load(main);
const cells = order(Object.keys(M.byCell));
const perMin = (r, f) => f(r) * 60000 / r.pageLifeMs;
const sdkReqs = (r, kind) => r.requests.filter((x) => x.kind === kind);
const sumBy = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
const servedJs = (r) => r.served.filter((s) => s.url !== "/app.js");

console.log(`Runs: ${M.ok.length} ok, ${M.failed.length} failed; rounds ${main.rounds}; journey ${main.journeyS} s; Chromium ${main.chromium}; started ${main.started}\n`);
for (const f of M.failed) console.log(`- failed: ${f.cell} round ${f.round}: ${f.error.split("\n")[0]}`);
const n = (c) => M.byCell[c].length;

console.log("### Bundle (gzip -9 KB)\n");
console.log(row(["cell", "eager (built)", "lazy (built)", "JS downloaded in the run", "files downloaded"]));
console.log(sep(5));
for (const c of cells) {
  const s = sizes[c];
  const dl = M.vals(c, (r) => kb(sumBy(servedJs(r), "gz9")));
  const files = [...new Set(M.byCell[c].flatMap((r) => servedJs(r).map((x) => x.url.replace(/^\/c\/[^/]+\//, ""))))];
  console.log(row([c, fmt(kb(s.eager.gz9), 1), fmt(kb(s.lazy.gz9), 1), fmt(q(dl, 0.5), 1), files.join(", ")]));
}

console.log("\n### Page load (ms; median [IQR]; Δ = paired delta vs none, median [IQR])\n");
console.log(row(["cell", "N", "SDK init done", "load event end", "main-thread task (load+3 s)", "Δ task", "Δ script", "long tasks", "longest task", "TBT", "Δ TBT"]));
console.log(sep(11));
for (const c of cells) {
  const t = (r) => r.cpu.load.task * 1000, s = (r) => r.cpu.load.script * 1000, tbt = (r) => r.longTasks.load.tbt;
  console.log(row([c, n(c), med(M.vals(c, (r) => r.load.sdkInitDone), 1), med(M.vals(c, (r) => r.load.loadEnd), 1), med(M.vals(c, t)), med(M.delta(c, t)), med(M.delta(c, s)),
    med(M.vals(c, (r) => r.longTasks.load.count)), med(M.vals(c, (r) => r.longTasks.load.max)), med(M.vals(c, tbt)), med(M.delta(c, tbt))]));
}

console.log(`\n### Journey (${main.journeyS} s): CPU, long tasks, heap (median [IQR]; Δ = paired delta vs none, median [IQR])\n`);
console.log(row(["cell", "main-thread task ms", "Δ task ms", "Δ script ms", "renderer CPU ms (all threads)", "Δ renderer ms", "long tasks", "long-task sum ms", "TBT ms", "heap after GC MB", "Δ heap MB"]));
console.log(sep(11));
for (const c of cells) {
  const t = (r) => r.cpu.journey.task * 1000, s = (r) => r.cpu.journey.script * 1000, rc = (r) => r.cpu.journey.renderer * 1000, h = (r) => r.heap.endAfterGc / 1048576;
  console.log(row([c, med(M.vals(c, t)), med(M.delta(c, t)), med(M.delta(c, s)), med(M.vals(c, rc)), med(M.delta(c, rc)),
    med(M.vals(c, (r) => r.longTasks.journey.count)), med(M.vals(c, (r) => r.longTasks.journey.sum)), med(M.vals(c, (r) => r.longTasks.journey.tbt)), med(M.vals(c, h), 1), med(M.delta(c, h), 1)]));
}

console.log("\n### Network per minute of page life (load + journey + page-hide flush; KB; median [IQR])\n");
console.log(row(["cell", "telemetry req", "telemetry wire", "telemetry decoded", "replay req", "replay wire", "replay decoded", "preflights", "page-hide wire", "non-local requests"]));
console.log(sep(10));
for (const c of cells) {
  const pm = (kind, k) => M.vals(c, (r) => perMin(r, (x) => sumBy(sdkReqs(x, kind), k)));
  const cnt = (kind) => M.vals(c, (r) => perMin(r, (x) => sdkReqs(x, kind).length));
  const hide = M.vals(c, (r) => kb(sumBy(r.requests.filter((x) => x.phase === "hide" && x.sdk !== "app"), "wire")));
  const ext = M.vals(c, (r) => r.external.length).reduce((a, b) => a + b, 0);
  console.log(row([c, med(cnt("telemetry")), med(pm("telemetry", "wire").map(kb), 1), med(pm("telemetry", "decoded").map(kb), 1), med(cnt("replay")), med(pm("replay", "wire").map(kb), 1), med(pm("replay", "decoded").map(kb), 1), med(cnt("preflight")), med(hide, 1), ext]));
}
const errs = M.ok.filter((r) => r.errors.length);
if (errs.length) console.log(`\nPage errors (other than the journey's own thrown error): ${[...new Set(errs.flatMap((r) => r.errors.map((e) => `${r.cell}: ${e}`)))].slice(0, 10).join("; ")}`);

if (largePath) {
  const large = JSON.parse(await readFile(largePath, "utf8"));
  const L = load(large);
  console.log(`\n### Large DOM (${large.nodes} target nodes; ${large.rounds} rounds; load + 3 s settle; ms)\n`);
  console.log(row(["cell", "N", "DOM nodes", "longest task", "Δ longest", "TBT", "main-thread task", "Δ task", "first replay request at (ms from nav)", "first replay wire KB", "first replay decoded KB"]));
  console.log(sep(11));
  for (const c of order(Object.keys(L.byCell))) {
    const first = (r) => r.requests.filter((x) => x.kind === "replay").sort((a, b) => a.t - b.t)[0];
    console.log(row([c, L.byCell[c].length, med(L.vals(c, (r) => r.load.nodes)), med(L.vals(c, (r) => r.longTasks.load.max)), fmt(q(L.delta(c, (r) => r.longTasks.load.max), 0.5)), med(L.vals(c, (r) => r.longTasks.load.tbt)),
      med(L.vals(c, (r) => r.cpu.load.task * 1000)), fmt(q(L.delta(c, (r) => r.cpu.load.task * 1000), 0.5)),
      med(L.vals(c, (r) => first(r)?.t ?? NaN)), med(L.vals(c, (r) => kb(first(r)?.wire ?? NaN)), 1), med(L.vals(c, (r) => kb(first(r)?.decoded ?? NaN)), 1)]));
  }
}
