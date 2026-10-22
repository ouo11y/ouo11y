#!/usr/bin/env python3
"""Builds project/agents/ios-replay/reports/n6-g1-replay-crashes.html from perf/results/ (self-contained HTML).

    python3 -I report.py

results/sim (and results/device once measured on the iPhone) hold:
  tp/<build>/r<n>/stalls.json      capture_stalls.py output (per-capture main-thread CPU and wall, ouo and Sentry)
  tp/<build>/r<n>/signposts.json   signposts.py output (after build: snapshot on main, compose on the queue)
  cpu-<build>.json                 scripts/perf/analyze.py summary (CPU, memory, JS frames per mode)
  render-variants.json             signposts of the one-off render experiment
  crash/<flow>/                    crash-flow.sh output: report.json, fatal.txt, session.json (rum-api)
"""
import base64
import html
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "results")
OUT = os.path.join(HERE, "..", "reports", "n6-g1-replay-crashes.html")
BUILDS = [("baseline", "before (main)"), ("after3", "after (this branch)")]


def load(*p):
    path = os.path.join(DATA, *p)
    return json.load(open(path)) if os.path.exists(path) else None


def esc(s):
    return html.escape(str(s))


def f1(x):
    return "–" if x is None else f"{x:.1f}"


def rounds(env, build):
    out = []
    for r in (1, 2, 3):
        s = load(env, "tp", build, f"r{r}", "stalls.json")
        if s:
            out.append((r, s, load(env, "tp", build, f"r{r}", "signposts.json")))
    return out


# ---------------------------------------------------------------- per-capture strip chart
SERIES = {"ouo-before": ("--s-before", "ouo, before"), "ouo-after": ("--s-after", "ouo, after"), "sentry": ("--s-sentry", "Sentry (same traces)")}


def strip_chart(env, metric="cpu"):
    rows = []
    for build, label in BUILDS:
        for r, s, _ in rounds(env, build):
            key = "ouo-before" if build == "baseline" else "ouo-after"
            rows.append((key, f"ouo · {label} · round {r}", s["ouo"][metric]))
            rows.append(("sentry", f"Sentry · {label} build · round {r}", s["sentry"][metric]))
    if not rows:
        return "<p class='muted'>No data yet.</p>"
    xmax = max(60, max(max(v["values"]) for _, _, v in rows if v.get("values")))
    xmax = min(xmax, 100)
    W, left, right, rowh, top = 760, 250, 20, 26, 22
    H = top + rowh * len(rows) + 34
    sx = lambda v: left + (min(v, xmax) / xmax) * (W - left - right)
    parts = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Per-capture main-thread {metric} time, every capture as a dot, median as a bar" class="chart">']
    for t in range(0, int(xmax) + 1, 10):
        x = sx(t)
        parts.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{top}" y2="{H-30}" class="grid"/>'
                     f'<text x="{x:.1f}" y="{H-14}" class="tick" text-anchor="middle">{t}</text>')
    x16 = sx(1000 / 60)
    parts.append(f'<line x1="{x16:.1f}" x2="{x16:.1f}" y1="{top-4}" y2="{H-30}" class="budget"/>'
                 f'<text x="{x16+4:.1f}" y="{top-8}" class="tick">one 60 Hz frame (16.7 ms)</text>')
    parts.append(f'<text x="{(left+W-right)/2:.0f}" y="{H-1}" class="tick" text-anchor="middle">ms of main thread per capture ({metric})</text>')
    for i, (key, label, v) in enumerate(rows):
        y = top + i * rowh + rowh / 2
        var, _ = SERIES[key]
        parts.append(f'<text x="{left-10}" y="{y+4:.1f}" class="lab" text-anchor="end">{esc(label)}</text>')
        vals = v.get("values", [])
        for j, val in enumerate(vals):
            jitter = ((j * 37) % 11 - 5) * 0.9
            parts.append(f'<circle cx="{sx(val):.1f}" cy="{y+jitter:.1f}" r="2.6" fill="var({var})" fill-opacity="0.45">'
                         f'<title>{esc(label)}: {val} ms</title></circle>')
        m = v["median_ms"]
        parts.append(f'<rect x="{sx(m)-2:.1f}" y="{y-9:.1f}" width="4" height="18" rx="2" fill="var({var})" stroke="var(--surface)" stroke-width="2">'
                     f'<title>{esc(label)}: median {m:.1f} ms, p95 {v["p95_ms"]:.1f} ms, {len(vals)} captures</title></rect>')
        parts.append(f'<text x="{W-right}" y="{y+4:.1f}" class="val" text-anchor="end">{m:.1f}</text>')
    parts.append("</svg>")
    legend = "".join(f'<span class="key"><i style="background:var({var})"></i>{esc(lbl)}</span>' for var, lbl in SERIES.values())
    return f'<div class="legend">{legend}</div>' + "".join(parts)


def stall_table(env):
    rows = []
    for build, label in BUILDS:
        for r, s, sp in rounds(env, build):
            o, se = s["ouo"], s["sentry"]
            snap = sp.get("snapshot", {}).get("median_ms") if sp else None
            comp = sp.get("compose", {}).get("median_ms") if sp else None
            rows.append(f"<tr><td>{esc(label)}</td><td>{r}</td><td>{o['captures']}</td>"
                        f"<td>{f1(o['cpu']['median_ms'])}</td><td>{f1(o['cpu']['p95_ms'])}</td><td>{f1(o['wall']['median_ms'])}</td>"
                        f"<td>{o['wall']['over_16ms']}</td><td>{f1(o['cpu']['total_ms']/1000*1000)}</td>"
                        f"<td>{f1(snap)}</td><td>{f1(comp)}</td>"
                        f"<td>{f1(se['cpu']['median_ms'])}</td><td>{f1(se['wall']['median_ms'])}</td></tr>")
    if not rows:
        return "<p class='muted'>No data yet.</p>"
    return ("<div class='scroll'><table><thead><tr><th>Build</th><th>Round</th><th>ouo captures</th><th>ouo CPU median ms</th><th>ouo CPU p95</th>"
            "<th>ouo wall median</th><th>ouo captures over 16.7 ms (wall)</th><th>ouo main-thread total ms (80 s)</th>"
            "<th>signpost snapshot (main) median</th><th>signpost compose (queue) median</th>"
            "<th>Sentry CPU median</th><th>Sentry wall median</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>")


def cpu_table(env):
    modes = [("ouo-replay", "ouo only, replay on"), ("both-replay", "Sentry + ouo, both replays"), ("sentry", "Sentry only (control)")]
    metrics = [("cpu_pct", "CPU, journey (% of a core)"), ("idle_cpu_pct", "CPU, idle tail (%)"), ("steady_mb", "Memory steady (MB)"),
               ("peak_mb", "Memory peak (MB)"), ("dropped", "JS frames dropped"), ("long_frames", "JS frames > 50 ms"), ("start_ms", "JS start to first frame (ms)")]
    data = {b: load(env, f"cpu-{b}.json") for b, _ in BUILDS}
    if not all(data.values()):
        return "<p class='muted'>No data yet.</p>"
    head = "".join(f"<th>{esc(m)}<span class='r'>before → after</span></th>" for _, m in modes)
    body = []
    for k, label in metrics:
        cells = []
        for mode, _ in modes:
            a = data["baseline"]["modes"].get(mode, {}).get(k, {})
            b = data["after3"]["modes"].get(mode, {}).get(k, {})
            if not a or not b:
                cells.append("<td>–</td>")
                continue
            cells.append(f"<td>{f1(a['median'])} → <b>{f1(b['median'])}</b><span class='r'>{f1(a['min'])}–{f1(a['max'])} → {f1(b['min'])}–{f1(b['max'])}</span></td>")
        body.append(f"<tr><td>{esc(label)}</td>{''.join(cells)}</tr>")
    n = data["after3"]["modes"]["ouo-replay"]["cpu_pct"]["n"]
    return (f"<div class='scroll'><table><thead><tr><th>Metric (median of {n} runs, range below)</th>{head}</tr></thead><tbody>"
            + "".join(body) + "</tbody></table></div>")


def variants_table(env):
    v = load(env, "render-variants.json")
    if not v:
        return ""
    names = [("v0-srgb", "drawHierarchy into 8-bit sRGB at scale 1.144"), ("v2-device", "8-bit device RGB at 1.144"),
             ("v1-p3", "8-bit Display P3 at 1.144"), ("v5-p3-again", "8-bit Display P3 at 1.144 (repeat)"),
             ("v4-p3-scale1", "8-bit Display P3 at scale 1.0 (shipped)"), ("v3-p3-layerrender", "layer.render(in:), Display P3 (not shipped)")]
    rows = "".join(f"<tr><td>{esc(lbl)}</td><td>{v[k]['n']}</td><td>{f1(v[k]['median_ms'])}</td><td>{f1(v[k]['p95_ms'])}</td></tr>"
                   for k, lbl in names if k in v)
    return ("<div class='scroll'><table><thead><tr><th>Render variant (one run, rotated per capture)</th><th>Captures</th>"
            "<th>Median ms</th><th>p95 ms</th></tr></thead><tbody>" + rows + "</tbody></table></div>")


def crash_rows(env):
    flows = [("parallel-1", "native crash (`Sentry.nativeCrash`, SIGSEGV), Sentry + ouo"),
             ("ouo-2", "native crash, ouo only (Sentry linked, not started), replay on"),
             ("jsfatal-1", "JS fatal in Release (React Native aborts with RCTFatalException), Sentry + ouo")]
    rows = []
    for key, label in flows:
        s = load(env, "crash", key, "session.json")
        rep = load(env, "crash", key, "report.json")
        if not s:
            continue
        mech = rep["mechanism"] + (f" {rep['signal']['name']}" if rep.get("signal") else f" {rep.get('exception', {}).get('name', '')[:40]}") if rep else "–"
        rows.append(f"<tr><td>{esc(label)}</td><td>{esc(mech)}</td><td>{esc(s.get('status'))}</td><td>{esc(s.get('end_reason'))}</td>"
                    f"<td>{esc(s.get('started_at'))}</td><td>{esc(s.get('ended_at'))}</td><td>{s.get('crash_count')}</td>"
                    f"<td>{len(rep['frames']) if rep else '–'} / {len(rep['images']) if rep else '–'}</td></tr>")
    return ("<div class='scroll'><table><thead><tr><th>Flow</th><th>ouo report on disk</th><th>rum-api status</th><th>end reason</th>"
            "<th>started</th><th>ended (= crash time)</th><th>crashes</th><th>frames / images</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table></div>")


def stack_excerpt(env):
    t = os.path.join(DATA, env, "crash", "ouo-2", "fatal.txt")
    if not os.path.exists(t):
        return ""
    lines = open(t).read().splitlines()
    return "<pre>" + esc("\n".join(lines[:14])) + "</pre>"


def img(env, name, alt, width):
    p = os.path.join(DATA, env, name)
    if not os.path.exists(p):
        return ""
    b = base64.b64encode(open(p, "rb").read()).decode()
    return f'<img src="data:image/jpeg;base64,{b}" alt="{esc(alt)}" style="max-width:{width}px">'


def device_section():
    if not os.path.isdir(os.path.join(DATA, "device")):
        return ("<p><b>Not measured yet.</b> The device run (iPhone 16 Pro Max, iOS 18.6.2) waits for the founder's go-ahead: "
                "the phone has to be plugged in and a development team added in Xcode (this Mac has no signing identity). "
                "Same scripts: <code>profile-runs.sh --device &lt;udid&gt; --signposts</code> against a device build; "
                "the simulator numbers below overstate rendering cost (the simulator renders on the CPU).</p>")
    return (f"<h3>Per capture, main thread (CPU)</h3>{strip_chart('device')}{stall_table('device')}"
            f"<h3>CPU, memory, frames</h3>{cpu_table('device')}")


def main():
    env = "sim"
    css = """
:root{--surface:#fcfcfb;--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#7a7974;--line:#e4e3df;--card:#f4f3f0;
--s-before:#eb6834;--s-after:#2a78d6;--s-sentry:#1baf7a;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--surface:#1a1a19;--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9a998f;--line:#33332f;--card:#232321;
--s-before:#d95926;--s-after:#3987e5;--s-sentry:#199e70;color-scheme:dark}}
:root[data-theme="dark"]{--surface:#1a1a19;--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9a998f;--line:#33332f;--card:#232321;
--s-before:#d95926;--s-after:#3987e5;--s-sentry:#199e70;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 8px;border-top:1px solid var(--line);padding-top:20px}h3{font-size:16px;margin:22px 0 6px}
p,li{color:var(--ink2)}b,strong{color:var(--ink)}.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:18px 0}
.tile{background:var(--card);border-radius:10px;padding:14px}.tile .n{font-size:28px;font-weight:650;color:var(--ink)}.tile .l{font-size:13px;color:var(--ink2)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--ink2);font-weight:600}
.r{display:block;color:var(--muted);font-size:11px;font-weight:400}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--line);stroke-width:1}.chart .budget{stroke:var(--muted);stroke-dasharray:3 3}
.chart .tick{fill:var(--muted);font-size:11px}.chart .lab{fill:var(--ink2);font-size:12px}.chart .val{fill:var(--ink);font-size:12px;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--ink2);margin:6px 0}.key i{display:inline-block;width:10px;height:10px;border-radius:5px;margin-right:6px}
pre{background:var(--card);padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;color:var(--ink)}
code{font-size:13px}.figs{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.figs figure{margin:0}.figs figcaption{font-size:12px;color:var(--muted)}
img{border-radius:6px;border:1px solid var(--line);width:100%;height:auto}
"""
    b = {bld: rounds(env, bld) for bld, _ in BUILDS}
    med = lambda bld, sdk: statistics.median(s[sdk]["cpu"]["median_ms"] for _, s, _ in b[bld]) if b[bld] else None
    tiles = [
        (f"{f1(med('baseline','ouo'))} → {f1(med('after3','ouo'))} ms", "ouo main-thread CPU per capture, median of round medians (simulator)"),
        (f"{f1(med('after3','sentry'))} ms", "Sentry per capture in the same traces (simulator)"),
        ("2.6 ms", "capture-queue compose per frame (redaction, thumbnail, JPEG, chunk), off the main thread"),
        ("crashed", "native crash session status in rum-api and Grafana, ended at the crash time"),
    ]
    tiles_html = "".join(f"<div class='tile'><div class='n'>{esc(n)}</div><div class='l'>{esc(l)}</div></div>" for n, l in tiles)
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iOS replay and native crashes</title><style>{css}</style></head><body><main>
<h1>iOS replay off the main thread (N6) and native crashes (G1)</h1>
<p class="muted">ios-replay agent, 2026-10-23. Branch <code>claude/b1-ios-replay-crashes</code>. Data and scripts: <code>project/agents/ios-replay/perf/</code>.</p>
<div class="tiles">{tiles_html}</div>

<h2>N6: what one capture costs the main thread</h2>
<p>Each dot is one capture in a 80 s Time Profiler recording of the sentry-mobile perf journey (<code>both-replay</code>: Sentry's replay and ouo's run at once, real taps), the bar is the median.
ouo and Sentry are measured by the same rule in the same traces (<code>capture_stalls.py</code>: main-thread samples whose stack holds the recorder's capture code, samples &lt; 50 ms apart belong to one capture).
The simulator renders on the CPU, so absolute values are high for both SDKs; compare within a row group.</p>
{strip_chart(env, 'cpu')}
<h3>Table view, per round</h3>
{stall_table(env)}
<p>Before, 80 % of a capture was the render (<code>UIGraphicsImageRenderer</code> picks a 16-bit half-float bitmap on wide-color screens: decode, resample and convert in half floats), 16.5 % JPEG encoding, 2.4 % the dedupe thumbnail.
After, the main thread does the view walk and <code>drawHierarchy</code> into an 8-bit Display P3 bitmap at an integer downscale (3x → 1x); redaction, thumbnail, JPEG and chunking run on a serial capture queue.
Frames are 402 × 874 px (was 460 × 1001), still within the spec's 1000 px.</p>

<h3>Render variants (one run, signposts around drawHierarchy only)</h3>
{variants_table(env)}
<p><code>layer.render(in:)</code> is the fastest but does not draw backdrop / glass materials (iOS 26+ bars), blurs or video, so it is not the default.</p>

<h3>Whole app: CPU, memory, JS frames (simulator, sampler without profiler)</h3>
{cpu_table(env)}
<p>The Sentry-only control moved by less than the run-to-run spread, so the host did not drift between the two builds. ouo's replay costs about a fifth less CPU over the journey and when idle, with more frames captured (no capture is skipped behind a busy main thread); memory is unchanged.</p>

<h2>N6 on the iPhone 16 Pro Max</h2>
{device_section()}

<h2>G1: native crashes</h2>
<p>Signals (SIGSEGV, SIGBUS, SIGABRT, SIGILL, SIGFPE, SIGTRAP, SIGSYS) and uncaught NSExceptions are written to disk at crash time by async-signal-safe C (<code>OuoCrashCore</code>),
then sent on the next launch as a fatal <code>exception</code> of the crashed session, which ends with reason <code>crash</code> at the crash time (session-lifecycle spec, ADR-0004).
ouo calls the previously installed handlers after its own, so Sentry still reports the crash. Simulator runs with <code>crash-flow.sh</code> against the env stack:</p>
{crash_rows(env)}
<p>In the Sentry + ouo run Sentry reported the same crash through the bridge (<code>EXC_BAD_ACCESS</code>, same frames), so chaining works both ways round.
The JS fatal produced exactly one fatal exception (the JS one, with its JS stack); the native <code>RCTFatalException</code> report only set the end time (47 ms after the JS error).</p>
<h3>The stack as sent (exception.stacktrace)</h3>
{stack_excerpt(env)}
<p><code>ouo.crash.frames</code> (instruction_addr, image_addr) and <code>ouo.crash.images</code> (code_file, debug_id = LC_UUID, image_addr, image_size, image_vmaddr) ride along as JSON so the stack can be symbolicated later
(<code>atos -o App.dSYM/… -l &lt;image_addr&gt; &lt;instruction_addr&gt;</code>).</p>
<div class="figs">
<figure style="flex:2 1 420px">{img(env, 'grafana-crashed-session.jpg', 'Grafana ouo11y RUM session page: crashed, ended crash, fatal error SIGSEGV', 640)}
<figcaption>Grafana, ouo11y RUM app: the session is crashed with the native fatal error on its timeline. The plugin does not render stack traces yet; the stack is on the exception record in Explore (follow-up for the plugin).</figcaption></figure>
<figure style="flex:1 1 200px">{img(env, 'frame-product-masked.jpg', 'Replay frame after the change: product screen, back chevron image masked black', 240)}
<figcaption>A replay frame from the new capture path (402 × 874, Display P3): upright, the image view (back chevron) still masked black. sentry-mobile runs with text masking off.</figcaption></figure>
</div>

<h2>Limits and open points</h2>
<ul>
<li>Device numbers pending (above). The simulator overstates rendering, and other sessions shared the Mac during the runs.</li>
<li>Only the crashed thread's stack; no other threads. Crashes before <code>initRUM</code>, watchdog kills, OOM and SIGKILL are not caught in-process (MetricKit would be the next step).</li>
<li>The last replay chunk before a crash is in memory and is lost (Sentry keeps its segment on disk).</li>
<li>A crash within ~1 s of a new session can land before that session's <code>session.start</code> is exported; rum-api then reads the start from the first event.</li>
<li>The plugin shows the crash but not <code>exception.stacktrace</code>.</li>
</ul>
<h2>Method</h2>
<p>Simulator: iOS 27 "iPhone 18 Pro" (dedicated <code>ouo-b1-ios</code>), Release builds of <code>examples/sentry-mobile</code> with <code>OUO_PERF=1</code>, stack = <code>ouo-env</code> env <code>b1-ios-replay-crashes</code>.
Time Profiler: 3 rounds per build interleaved, 80 s each (<code>profile-runs.sh</code>, attaching to the journey's pid). Sampler: <code>scripts/perf/run.sh</code> unchanged, 3 rounds × 3 modes per build.
Crash flows: <code>crash-flow.sh</code> launches through a one-test XCUITest, which confirms iOS 27's "Open in …?" sheet for the deep link.</p>
</main></body></html>"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write(page)
    print(os.path.abspath(OUT))


if __name__ == "__main__":
    main()
