#!/usr/bin/env python3
"""One self-contained HTML report per benchmark run, from bench_result.py's result.json.

    python3 -I bench_report.py --result result.json --out report.html [--notes notes.html]

Per tier: Sentry and ouo side by side as the cost added over the no-SDK baseline (paired median
delta, IQR), and ouo minus Sentry. Lower is better for every metric; the colour says only which
side costs less. --notes is an HTML fragment (findings, the explanation of every loss) placed under
the headline. No external resources: the page renders offline.
"""
import argparse
import html
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report import CSS as BASE_CSS  # noqa: E402  the #25 report's palette and layout

CSS = BASE_CSS + """
.banner{background:var(--panel);border:1px solid var(--warn);border-left:5px solid var(--warn);border-radius:8px;padding:10px 14px;margin:14px 0;color:var(--ink)}
.win{color:var(--good);font-weight:600}.loss{color:var(--warn);font-weight:600}.even{color:var(--ink2)}
td.bar{width:170px;min-width:120px}td.bar svg{height:30px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;font-size:13px}.kv dt{color:var(--ink2)}.kv dd{margin:0}
details{margin:8px 0}summary{cursor:pointer;color:var(--ink2)}pre{white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;background:var(--grid);padding:8px;border-radius:6px}
"""

# (key, label, unit, precision)
METRICS = [
    ("cpu_pct", "CPU, journey average", "pp of one core", 1),
    ("cpu_p95_pct", "CPU, p95 of 1 s windows", "pp of one core", 1),
    ("idle_cpu_pct", "CPU, idle tail", "pp of one core", 1),
    ("steady_mb", "Memory, steady", "MB", 1),
    ("peak_mb", "Memory, peak", "MB", 1),
    ("start_ms", "Startup added (JS start to first frame)", "ms", 0),
    ("sdk_req", "SDK requests", "per 95 s run", 0),
    ("sdk_up_kb", "SDK bytes up, on the wire", "KB per run", 0),
    ("sdk_up_decoded_kb", "SDK bytes up, uncompressed", "KB per run", 0),
    ("replay_kb_min", "Replay upload", "KB per minute", 0),
    ("sdk_down_kb", "SDK bytes down", "KB per run", 1),
    ("backend_up_kb", "App API bytes up (trace headers)", "KB per run", 1),
    ("dropped_pct", "JS frames dropped", "% of frames", 2),
    ("long_frames", "JS long frames (> 50 ms)", "per run", 0),
    ("disk_sentry_kb", "On disk after the run: Sentry files", "KB", 0),
    ("disk_ouo_kb", "On disk after the run: ouo files", "KB", 0),
    ("energy_mj", "Energy", "mJ per run", 0),
]

TIER_TEXT = {
    "T1": "Errors, crashes and release-health sessions only. ouo cannot switch its fetch tracing off, so ouo's column is its T2.",
    "T2": "Plus tracing (navigation, fetch/XHR spans, propagation) and structured logs.",
    "T3": "Plus session replay with each SDK's defaults (masking on).",
    "T4": "Plus session replay at matched quality: 1 frame/s, 1 px per point, masking off in both.",
}


def esc(s):
    return html.escape(str(s))


def fmt(v, p):
    return "-" if v is None else f"{v:,.{p}f}"


def iqr(g, p, signed=False):
    if not g:
        return "-"
    f = (lambda v: f"{v:+,.{p}f}") if signed else (lambda v: f"{v:,.{p}f}")
    return f'{f(g["median"])}<span class="r">IQR {f(g["q1"])} to {f(g["q3"])}, n={g["n"]}</span>'


def mini_bar(a, b, p):
    """Two horizontal bars (Sentry, ouo) of the median delta with IQR whiskers, shared scale."""
    if not a or not b:
        return ""
    vals = [a["q1"], a["q3"], b["q1"], b["q3"], 0]
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        hi = lo + 1
    W, L = 170, 4
    x = lambda v: L + (W - 2 * L) * (v - lo) / (hi - lo)
    out = [f'<svg viewBox="0 0 {W} 30" role="img" aria-label="Sentry {a["median"]:.{p}f}, ouo {b["median"]:.{p}f}">',
           f'<line x1="{x(0):.1f}" x2="{x(0):.1f}" y1="0" y2="30" stroke="var(--muted)" stroke-width="1"/>']
    for i, (g, col) in enumerate(((a, "var(--s2)"), (b, "var(--s3)"))):
        y = 4 + i * 13
        x0, x1 = sorted((x(0), x(g["median"])))
        out.append(f'<rect x="{x0:.1f}" y="{y}" width="{max(1, x1 - x0):.1f}" height="9" rx="2" fill="{col}"/>')
        out.append(f'<line x1="{x(g["q1"]):.1f}" x2="{x(g["q3"]):.1f}" y1="{y + 4.5}" y2="{y + 4.5}" stroke="var(--ink)" stroke-width="1.2"/>')
    out.append("</svg>")
    return "".join(out)


def verdict(d, p):
    """ouo minus Sentry, paired: negative = ouo costs less. 'even' when the IQR spans zero."""
    if not d:
        return '<td class="even">-</td>'
    m = d["median"]
    if d["q1"] <= 0 <= d["q3"] or abs(m) < 0.5 * 10 ** -p:
        cls, word = "even", "within noise"
    elif m < 0:
        cls, word = "win", "ouo costs less"
    else:
        cls, word = "loss", "ouo costs more"
    return f'<td class="{cls}">{m:+,.{p}f}<span class="r">{word}; IQR {d["q1"]:+,.{p}f} to {d["q3"]:+,.{p}f}</span></td>'


def tier_section(r, tier, t):
    s, o = t["sentry"], t["ouo"]
    vs = r["vs_none"]
    rows = []
    for key, label, unit, p in METRICS:
        a = (vs.get(s) or {}).get(key)
        b = (vs.get(o) or {}).get(key)
        if not a and not b:
            continue
        d = (t.get("ouo_minus_sentry") or {}).get(key)
        ab_s = (r["cells"].get(s) or {}).get(key)
        ab_o = (r["cells"].get(o) or {}).get(key)
        rows.append(
            f"<tr><td>{esc(label)}<span class='r'>{esc(unit)}</span></td>"
            f"<td>{iqr(a, p, True)}<span class='r'>absolute {fmt(ab_s and ab_s['median'], p)}</span></td>"
            f"<td>{iqr(b, p, True)}<span class='r'>absolute {fmt(ab_o and ab_o['median'], p)}</span></td>"
            f"<td class='bar'>{mini_bar(a, b, p)}</td>{verdict(d, p)}</tr>")
    return f"""<h2 id="{tier}">{tier}: {esc(TIER_TEXT[tier])}</h2>
<p class="muted">Cost added over the no-SDK baseline: each run minus the <code>none</code> run of the same round, median and IQR
over the rounds. Bars: <span style="color:var(--s2)">■</span> Sentry (<code>{esc(s)}</code>), <span style="color:var(--s3)">■</span> ouo
(<code>{esc(o)}</code>), whiskers = IQR, the grey line = zero. Last column: ouo minus Sentry run by run in the same round.</p>
<div class="scroll"><table><thead><tr><th>Metric</th><th>Sentry added</th><th>ouo added</th><th></th><th>ouo minus Sentry</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>"""


def line_chart(series, title, unit, xmax=None):
    """series: [(label, colour, [[x, y], ...])]."""
    pts = [p for _, _, s in series for p in s]
    if not pts:
        return ""
    W, H, L, R, T, B = 900, 230, 46, 12, 10, 24
    xm = xmax or max(p[0] for p in pts)
    ym = max(p[1] for p in pts) * 1.08 or 1
    x = lambda v: L + (W - L - R) * v / xm
    y = lambda v: T + (H - T - B) * (1 - v / ym)
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{esc(title)}">']
    for i in range(5):
        v = ym * i / 4
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke="var(--grid)"/><text x="{L - 5}" y="{y(v) + 4:.1f}" text-anchor="end">{v:.0f}</text>')
    for i in range(6):
        v = xm * i / 5
        lab = f"{v / 60:.0f} min" if xm > 600 else f"{v:.0f} s"
        out.append(f'<text x="{x(v):.1f}" y="{H - 5}" text-anchor="middle">{lab}</text>')
    for label, col, s in series:
        if s:
            d = "".join(("M" if i == 0 else "L") + f"{x(a):.1f},{y(b):.1f}" for i, (a, b) in enumerate(s))
            out.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="1.8" stroke-linejoin="round"><title>{esc(label)}</title></path>')
    out.append("</svg>")
    legend = "".join(f'<span><i style="background:{c}"></i>{esc(l)}</span>' for l, c, _ in series)
    return f'<div class="card"><h3>{esc(title)}</h3><div class="u">{esc(unit)}</div><div class="legend">{legend}</div>{"".join(out)}</div>'


def size_section(r):
    sz = r.get("size")
    if not sz:
        return "<h2>App size</h2><p class='muted'>No size attribution in this run (build without link map / source map).</p>"
    rows = []
    n, j = sz.get("native", {}), sz.get("js", {})
    for g in ("sentry", "ouo"):
        nb = n.get("groups", {}).get(g)
        jb = j.get("groups", {}).get(g)
        rows.append(f"<tr><td>{'Sentry' if g == 'sentry' else 'ouo'}</td><td>{fmt(nb and nb / 1024, 0)}</td><td>{fmt(jb and jb / 1024, 0)}</td>"
                    f"<td>{fmt(((nb or 0) + (jb or 0)) / 1024, 0)}</td></tr>")
    tops = "".join(f"<tr><td>{esc(k)}</td><td>{v / 1024:,.0f}</td></tr>" for k, v in (j.get("top_packages") or [])[:15])
    libs = "".join(f"<tr><td>{esc(k)}</td><td>{v / 1024:,.0f}</td></tr>" for k, v in (n.get("top_libraries") or [])[:15])
    fws = "".join(f"<tr><td>{esc(k)}</td><td>{v / 1024:,.0f}</td></tr>" for k, v in (n.get("frameworks") or {}).items())
    return f"""<h2 id="size">App size added</h2>
<p class="muted">Attributed inside the one Release build every cell runs (<code>size.py</code>): native code from the linker map plus embedded
frameworks, JS from the Hermes bytecode bundle and its source map. Uncompressed bytes in the .app; the App Store download is
compressed and thinned. App total {sz['app_bytes'] / 2**20:,.1f} MB; JS bundle {fmt(j.get('bundle_bytes') and j['bundle_bytes'] / 1024, 0)} KB
({fmt(j.get('attributed_bytes') and 100 * j['attributed_bytes'] / j['bundle_bytes'], 0)} % attributed by the source map).</p>
<div class="scroll"><table><thead><tr><th>SDK</th><th>Native KB</th><th>JS bytecode KB</th><th>Total KB</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<details><summary>Largest JS packages, native libraries and frameworks</summary><div class="grid2">
<div class="scroll"><table><thead><tr><th>JS package</th><th>KB</th></tr></thead><tbody>{tops}</tbody></table></div>
<div class="scroll"><table><thead><tr><th>Native library</th><th>KB</th></tr></thead><tbody>{libs}{fws}</tbody></table></div></div></details>"""


def soak_offline(r):
    out = []
    soak = r.get("soak") or {}
    if soak:
        cols = {"none": "var(--s1)", "sentry-T3": "var(--s2)", "ouo-T3": "var(--s3)"}
        rows = "".join(f"<tr><td><code>{esc(c)}</code></td><td>{fmt(v.get('growth_mb_h'), 1)}</td><td>{fmt(v.get('soak_start_mb'), 1)}</td>"
                       f"<td>{fmt(v.get('soak_end_mb'), 1)}</td><td>{fmt(v.get('peak_mb'), 1)}</td></tr>" for c, v in soak.items())
        out.append(f"""<h2 id="soak">Memory over a {r['meta'].get('soak_minutes') or '?'} minute soak</h2>
<p class="muted">The journey repeated every 80 s, one run per cell. Growth: least-squares slope of phys_footprint from minute 5 on.</p>
<div class="scroll"><table><thead><tr><th>Cell</th><th>Growth MB/h</th><th>At 5 min MB</th><th>At end MB</th><th>Peak MB</th></tr></thead><tbody>{rows}</tbody></table></div>
{line_chart([(c, cols.get(c, 'var(--s4)'), v.get('series') or []) for c, v in soak.items()], 'phys_footprint during the soak', 'MB')}""")
    off, rec = r.get("offline") or {}, r.get("recover") or {}
    if off:
        rows = "".join(
            f"<tr><td><code>{esc(c)}</code></td><td>{fmt(v.get('disk_sentry_kb'), 0)}</td><td>{fmt(v.get('disk_ouo_kb'), 0)}</td><td>{fmt(v.get('peak_mb'), 1)}</td>"
            f"<td>{fmt((rec.get(c) or {}).get('sdk_req'), 0)}</td><td>{fmt((rec.get(c) or {}).get('sdk_up_kb'), 0)}</td></tr>" for c, v in off.items())
        out.append(f"""<h2 id="offline">Offline buffer</h2>
<p class="muted">The journey with every SDK request refused (connection closed, as on a dead network), then the app relaunched online and
left idle for 40 s. On disk: the app container after the offline run, by SDK. Sent after reconnect: what the relaunch uploaded,
i.e. what the SDK kept from the offline run (plus the relaunch's own start-up traffic).</p>
<div class="scroll"><table><thead><tr><th>Cell</th><th>On disk, Sentry KB</th><th>On disk, ouo KB</th><th>Peak MB</th><th>Requests after reconnect</th><th>KB sent after reconnect</th></tr></thead><tbody>{rows}</tbody></table></div>""")
    return "".join(out)


def cpu_chart(r):
    cols = {"none": "var(--s1)", "sentry-T3": "var(--s2)", "ouo-T3": "var(--s3)"}
    series = []
    for run in r["runs"]:
        if run["kind"] == "main" and run["round"] == 1 and run["cell"] in cols and run.get("series"):
            series.append((run["cell"], cols[run["cell"]], [[p[0], p[1]] for p in run["series"]]))
    if not series:
        return ""
    return ('<h2 id="cpu">CPU over one run (round 1, T3)</h2><p class="muted">CPU % of one core per second from the launch request. '
            'Taps from 6 s to 74 s, idle tail 80 to 95 s.</p>' + line_chart(sorted(series), "CPU per second", "% of one core", 95))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--notes")
    a = ap.parse_args()
    r = json.load(open(a.result))
    m = r["meta"]
    dev, v = m["device"], m["versions"]
    sim = dev.get("target") == "simulator"
    notes = open(a.notes).read() if a.notes and os.path.exists(a.notes) else ""
    banner = ('<div class="banner"><b>Simulator-only numbers.</b> The simulator runs the app as a Mac process: its CPU, memory and frame '
              'numbers do not represent a phone (rendering and video encoding run on the Mac\'s CPU, no thermal or power limits). '
              'Use them to compare runs of the harness, never as device costs.</div>') if sim else ""
    if m.get("sink"):
        banner += ('<div class="banner"><b>Sink mode.</b> SDK requests were answered by the proxy, not a real stack (CI has no Docker): '
                   'bytes up are the SDKs\' own, response latency and retries are not.</div>')
    probs = r.get("problems") or []
    prob_html = ("<details open><summary>{} problem(s) in this run</summary><ul>{}</ul></details>".format(
        len(probs), "".join(f"<li>{esc(p)}</li>" for p in probs)) if probs else "<p class='muted'>No run problems (every run: perf.json, 19/19 taps, the usual backend requests).</p>")
    kv = {
        "Device": f"{dev.get('name')} ({dev.get('model')}), {dev.get('target')}, OS {dev.get('os')} {dev.get('os_build') or ''}",
        "@ouo11y/react-native": v.get("@ouo11y/react-native"),
        "@sentry/react-native": f"{v.get('@sentry/react-native')} (sentry-cocoa {v.get('sentry-cocoa') or '?'})",
        "React Native / Expo": f"{v.get('react-native')} / {v.get('expo')}",
        "Xcode": v.get("xcode"), "Git": f"{v.get('git_sha', '')[:10]}{' (dirty)' if v.get('git_dirty') else ''}",
        "Runs": f"{m['runs']} rounds × {len(m['cells'])} cells, {m['seconds']:.0f} s each, interleaved and rotated",
        "Started / finished": f"{m.get('started')} / {m.get('finished')}",
    }
    kv_html = "".join(f"<dt>{esc(k)}</dt><dd>{esc(val)}</dd>" for k, val in kv.items())
    tiers = "".join(tier_section(r, t, r["tiers"][t]) for t in ("T1", "T2", "T3", "T4") if t in r["tiers"])
    configs = "".join(f"<li><code>{esc(c)}</code>: <code>{esc(json.dumps(cfg))}</code></li>" for c, cfg in m.get("configs", {}).items())
    abs_rows = []
    for key, label, unit, p in METRICS:
        cells = "".join(f"<td>{iqr((r['cells'].get(c) or {}).get(key), p)}</td>" for c in m["cells"])
        if any((r["cells"].get(c) or {}).get(key) for c in m["cells"]):
            abs_rows.append(f"<tr><td>{esc(label)}<span class='r'>{esc(unit)}</span></td>{cells}</tr>")
    miss = "".join(f"<td>{(r['cells'].get(c) or {}).get('runs_total', 0) - (r['cells'].get(c) or {}).get('replay_missing_runs', 0)}"
                   f" of {(r['cells'].get(c) or {}).get('runs_total', 0)}</td>" for c in m["cells"])
    abs_rows.insert(0, "<tr><td>Runs in the statistics<span class='r'>a run where an expected replay never uploaded is left out "
                       "and listed under run checks</span></td>" + miss + "</tr>")
    abs_head = "".join(f"<th>{esc(c)}</th>" for c in m["cells"])
    title = f"ouo {v.get('@ouo11y/react-native')} vs Sentry {v.get('@sentry/react-native')}"
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device cost benchmark</title><style>{CSS}</style></head><body><main>
<h1>Device cost: {esc(title)}</h1>
<p class="sub">What each SDK adds on the end device, per tier, against the same app with no SDK. Method and fairness rules:
<code>docs/benchmarks.md</code>. Generated by <code>examples/sentry-mobile/scripts/perf/bench_report.py</code>.</p>
{banner}<dl class="kv">{kv_html}</dl>
{notes}
<p><a href="#T1">T1</a> · <a href="#T2">T2</a> · <a href="#T3">T3</a> · <a href="#T4">T4</a> · <a href="#size">size</a> · <a href="#soak">soak</a> · <a href="#offline">offline</a> · <a href="#abs">all cells</a> · <a href="#method">configs</a></p>
{tiers}
{size_section(r)}
{cpu_chart(r)}
{soak_offline(r)}
<h2 id="abs">Every cell, absolute numbers</h2>
<p class="muted">Median, IQR under it. Refresh rate measured from the JS frame histogram: {', '.join(f"{c} {(r['cells'].get(c) or {}).get('refresh_hz')} Hz" for c in m['cells'][:1])}.</p>
<div class="scroll"><table><thead><tr><th>Metric</th>{abs_head}</tr></thead><tbody>{''.join(abs_rows)}</tbody></table></div>
<h2 id="method">Configs and run checks</h2>
<p class="muted">Each cell's <code>Documents/perf-mode.json</code>; the SDK options per tier are in <code>configs/</code> next to this report.</p>
<ul>{configs}</ul>
{prob_html}
</main></body></html>"""
    with open(a.out, "w") as f:
        f.write(page)
    print(a.out)


if __name__ == "__main__":
    main()
