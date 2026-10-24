// Renders the soak and rrweb-cost results (e2e/soak.spec.ts, e2e/rrweb-cost.spec.ts) as one
// self-contained HTML page: no network needed to view it.
//   node scripts/soak-report.mjs <results dir> <out.html> [title]
// The results dir holds soak-<engine>.json and rrweb-cost-<engine>.json (any subset);
// rrweb-cost files in sub-directories are included too (for example a 50k-element run).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, out, title = "@ouo11y/browser long sessions"] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: node scripts/soak-report.mjs <results dir> <out.html> [title]");
  process.exit(2);
}
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const all = existsSync(dir) ? files(dir) : [];
const soaks = all.filter((f) => /soak-[a-z]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(f, "utf8")));
const costs = all.filter((f) => /rrweb-cost-[a-z]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(f, "utf8")));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** A small line chart of one series over time, inline SVG. */
function chart(samples, key, label) {
  const pts = samples.filter((s) => typeof s[key] === "number");
  if (pts.length < 2) return "";
  const W = 320, H = 90, P = 24;
  const xs = pts.map((s) => s.t), ys = pts.map((s) => s[key]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = Math.min(0, ...ys), hi = Math.max(...ys) * 1.15 || 1;
  const px = (t) => P + ((t - x0) / (x1 - x0 || 1)) * (W - P - 6);
  const py = (v) => H - 16 - ((v - lo) / (hi - lo)) * (H - 28);
  const d = pts.map((s, i) => `${i ? "L" : "M"}${px(s.t).toFixed(1)},${py(s[key]).toFixed(1)}`).join("");
  const last = ys[ys.length - 1];
  return `<figure><figcaption>${esc(label)} <b>${esc(last)}</b> <span class="muted">(min ${Math.min(...ys)}, max ${Math.max(...ys)})</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} over time"><line class="axis" x1="${P}" y1="${H - 16}" x2="${W - 6}" y2="${H - 16}"/>
<text x="${P}" y="${H - 3}" class="tick">0 min</text><text x="${W - 6}" y="${H - 3}" class="tick" text-anchor="end">${Math.round(x1 / 60)} min</text>
<text x="${P - 4}" y="${py(hi / 1.15) + 4}" class="tick" text-anchor="end">${Math.round(hi / 1.15)}</text>
<path d="${d}" class="line"/></svg></figure>`;
}

const soakHtml = soaks
  .map((s) => {
    const samples = s.samples;
    const charts = [
      ["listeners", "listeners on window / document"],
      ["observers", "active observers"],
      ["timers", "pending timeouts"],
      ["nodes", "DOM elements"],
      ["heapMB", "JS heap after GC (MB)"],
      ["cdpListeners", "engine listener count (CDP)"],
    ]
      .map(([k, l]) => chart(samples, k, l))
      .join("");
    return `<section><h2>Soak, ${esc(s.browserName)}: ${s.minutes} min, a sample every ${s.sampleSeconds} s</h2>
<p>Delivered in total: ${s.totals.logs} log records, ${s.totals.spans} spans, ${s.totals.replay} replay chunks; rejected ${s.totals.rejected}.</p>
<div class="grid">${charts}</div></section>`;
  })
  .join("");

const cols = ["mode", "nodes", "snapshotKB", "startTaskMs", "startBlockedMs", "churnScriptMs", "churnTaskMs", "churnBlockedMs", "heapMB", "replayKB"];
const costHtml = costs
  .map(
    (c) => `<section><h2>rrweb cost, ${esc(c.browserName)}, ${c.nodes} elements</h2>
<table><thead><tr>${cols.map((k) => `<th>${k}</th>`).join("")}</tr></thead><tbody>
${c.results.map((r) => `<tr>${cols.map((k) => `<td>${r[k] ?? "n/a"}</td>`).join("")}</tr>`).join("\n")}
</tbody></table></section>`,
  )
  .join("");

writeFileSync(
  out,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#fff;--fg:#1d2330;--muted:#667085;--line:#2f6fde;--axis:#c9ced8;--card:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e8ec;--muted:#98a2b3;--line:#6ea0ff;--axis:#3a404b;--card:#1c2027}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1060px;padding:16px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
figure{margin:0;background:var(--card);border-radius:8px;padding:8px 10px}figcaption{font-size:13px}
svg{width:100%;height:auto}.line{fill:none;stroke:var(--line);stroke-width:2}.axis{stroke:var(--axis)}.tick{fill:var(--muted);font-size:10px}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block}th,td{padding:4px 8px;border-bottom:1px solid var(--axis);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}
</style></head><body><h1>${esc(title)}</h1>
<p class="muted">Generated by sdk/browser/scripts/soak-report.mjs from the JSON results of e2e/soak.spec.ts and e2e/rrweb-cost.spec.ts. Pass rule of the soak: after the first 20 % of samples nothing grows beyond the warm-up maximum plus a small slack, and the heap's late median stays within 15 % (+2 MB) of its early median.</p>
<p class="muted">rrweb cost columns: snapshotKB, the first full snapshot's JSON; start*, the 2 s after initRUM; churn*, 10 s of 1000 cell texts changed every 100 ms; *TaskMs / *ScriptMs, CDP Performance.getMetrics deltas (Chromium only); *BlockedMs, the lag of a 10 ms timer chain summed over lags above 20 ms; heapMB, after a forced GC; replayKB, the uncompressed JSON delivered.</p>
${soakHtml}${costHtml}</body></html>`,
);
console.log(`wrote ${out}: ${soaks.length} soak, ${costs.length} rrweb-cost result(s)`);
