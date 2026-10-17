#!/usr/bin/env python3
"""Self-contained HTML report from analyze.py's summary JSON.

    python3 -I report.py --summary summary.json --notes notes.html --out report.html

--notes is an HTML fragment (claim, findings, caveats) placed after the headline tiles; the charts,
tables and method are generated. No external resources: the page renders offline.
"""
import argparse
import html
import json

MODES = [
    ("none", "No SDK", "baseline: same binary, neither SDK started"),
    ("sentry", "Sentry only", "@sentry/react-native, tracing, logs, Session Replay"),
    ("both", "Sentry + ouo, ouo replay off", "ouo's default (ADR-0006)"),
    ("both-replay", "Sentry + ouo, ouo replay on", "two screen recorders"),
    ("ouo-replay", "ouo only, replay on", "Sentry linked, not started"),
]

METRICS = [
    ("cpu_pct", "CPU, journey average", "% of one core", 1),
    ("idle_cpu_pct", "CPU, idle tail (80-95 s)", "% of one core", 1),
    ("steady_mb", "Memory, steady (idle tail median)", "MB phys_footprint", 1),
    ("peak_mb", "Memory, peak", "MB phys_footprint", 1),
    ("start_ms", "App start, JS start to first frame", "ms", 0),
    ("sdk_req", "SDK requests", "per 95 s run", 0),
    ("sdk_sent_kb", "SDK upload", "KB per 95 s run", 0),
    ("dropped", "JS frames dropped", "frames per run", 0),
    ("long_frames", "JS long frames (> 50 ms)", "per run", 0),
    ("energy_j", "Energy (host kernel estimate)", "J per run", 1),
]

CSS = """
:root{color-scheme:light;--bg:#fcfcfb;--panel:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--muted:#8a8984;--rule:#e4e3df;--grid:#efeeea;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--band:rgba(42,120,214,.16);--dot:rgba(42,120,214,.55);--warn:#b45309;--good:#15803d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1a19;--panel:#222220;--ink:#f0efec;--ink2:#c3c2b7;--muted:#8f8e86;--rule:#3a3936;--grid:#2c2b29;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--band:rgba(57,135,229,.22);--dot:rgba(57,135,229,.6);--warn:#f59e0b;--good:#4ade80}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1a1a19;--panel:#222220;--ink:#f0efec;--ink2:#c3c2b7;--muted:#8f8e86;--rule:#3a3936;--grid:#2c2b29;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--band:rgba(57,135,229,.22);--dot:rgba(57,135,229,.6);--warn:#f59e0b;--good:#4ade80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:40px 0 8px;padding-top:8px;border-top:1px solid var(--rule)}
h3{font-size:15px;margin:18px 0 6px}.sub{color:var(--ink2);margin:0 0 20px}p,li{color:var(--ink)}.muted{color:var(--muted)}code{font:13px ui-monospace,Menlo,monospace;background:var(--grid);padding:1px 4px;border-radius:4px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:16px 0}.tile{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:12px 14px}
.tile .k{font-size:12px;color:var(--ink2);text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:26px;font-weight:650;margin:2px 0}.tile .d{font-size:12.5px;color:var(--ink2)}
.claim{background:var(--panel);border:1px solid var(--rule);border-left:4px solid var(--s1);border-radius:8px;padding:14px 18px;margin:16px 0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:14px}.card{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:12px 14px;min-width:0}
.card h3{margin:0 0 2px}.card .u{font-size:12px;color:var(--muted);margin-bottom:6px}svg{display:block;width:100%;height:auto;overflow:visible}svg text{fill:var(--ink2);font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--ink2);margin:6px 0}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-2px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--rule);text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}
th{color:var(--ink2);font-weight:600}.r{display:block;color:var(--muted);font-size:11.5px;font-weight:400}.scroll{overflow-x:auto}
#tip{position:fixed;pointer-events:none;background:var(--panel);color:var(--ink);border:1px solid var(--rule);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;z-index:9;max-width:280px}
.hit{fill:transparent;cursor:default}
"""

JS = r"""
const D = JSON.parse(document.getElementById('data').textContent);
const MODES = D.modesMeta, NS='http://www.w3.org/2000/svg';
const tip = document.getElementById('tip');
function showTip(e, h){tip.innerHTML=h;tip.style.display='block';const x=Math.min(e.clientX+14, innerWidth-tip.offsetWidth-8);tip.style.left=x+'px';tip.style.top=(e.clientY+14)+'px'}
function hideTip(){tip.style.display='none'}
function el(n,a,p){const e=document.createElementNS(NS,n);for(const k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e}
function fmt(v,p){return v==null?'-':Number(v).toFixed(p)}
function niceMax(v){if(v<=0)return 1;const m=Math.pow(10,Math.floor(Math.log10(v)));for(const s of[1,1.2,1.5,2,2.5,3,4,5,6,8,10])if(s*m>=v)return s*m;return 10*m}

// Dot strips: one card per metric, one row per mode, a dot per run and a tick at the median.
function strips(){
  const host=document.getElementById('strips');
  for(const [key,title,unit,prec] of D.metrics){
    const card=document.createElement('div');card.className='card';
    card.innerHTML=`<h3>${title}</h3><div class="u">${unit} · dots = runs, bar = median</div>`;
    const W=460,L=150,R=14,rowH=26,H=MODES.length*rowH+24;
    const svg=el('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':title});
    let mx=0;for(const m of MODES){const s=D.modes[m[0]]?.[key];if(s)mx=Math.max(mx,s.max)}
    mx=niceMax(mx*1.05);const x=v=>L+(W-L-R)*v/mx;
    for(let i=0;i<=4;i++){const v=mx*i/4;el('line',{x1:x(v),x2:x(v),y1:4,y2:H-18,stroke:'var(--grid)'},svg);const t=el('text',{x:x(v),y:H-4,'text-anchor':'middle'},svg);t.textContent=fmt(v,mx<10?1:0)}
    MODES.forEach((m,i)=>{const s=D.modes[m[0]]?.[key];const y=10+i*rowH+rowH/2;
      const lab=el('text',{x:L-8,y:y+4,'text-anchor':'end'},svg);lab.textContent=m[1];
      if(!s)return;
      el('line',{x1:x(s.min),x2:x(s.max),y1:y,y2:y,stroke:'var(--band)','stroke-width':8,'stroke-linecap':'round'},svg);
      s.values.forEach(v=>el('circle',{cx:x(v),cy:y,r:4,fill:'var(--dot)',stroke:'var(--panel)','stroke-width':1},svg));
      el('line',{x1:x(s.median),x2:x(s.median),y1:y-9,y2:y+9,stroke:'var(--ink)','stroke-width':2.5,'stroke-linecap':'round'},svg);
      const hit=el('rect',{x:L,y:y-rowH/2,width:W-L-R,height:rowH,class:'hit'},svg);
      hit.addEventListener('mousemove',e=>showTip(e,`<b>${m[1]}</b><br>${title}: median <b>${fmt(s.median,prec)}</b> ${unit}<br>range ${fmt(s.min,prec)} to ${fmt(s.max,prec)} (n=${s.n})<br>runs: ${s.values.map(v=>fmt(v,prec)).join(', ')}`));
      hit.addEventListener('mouseleave',hideTip);
    });
    card.appendChild(svg);host.appendChild(card);
  }
}

// Time series small multiples: median across runs per second, min-max band, shared y scale.
function series(hostId, idx, title, unit){
  const host=document.getElementById(hostId);
  // The scale skips the first 3 s after JS start (start-up burst, up to 2 cores): clipped at the top.
  let mx=0;for(const m of MODES){const s=D.series[m[0]];if(s)for(const p of s.slice(3))mx=Math.max(mx,p[idx][2])}
  mx=niceMax(mx);
  for(const m of MODES){const s=D.series[m[0]];if(!s)continue;
    const card=document.createElement('div');card.className='card';card.innerHTML=`<h3>${m[1]}</h3><div class="u">${title}, ${unit}; line = median of runs, band = min to max</div>`;
    const W=460,H=170,L=34,R=8,T=8,B=20;const svg=el('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':m[1]+' '+title});
    const t1=s[s.length-1].t;const x=t=>L+(W-L-R)*t/95,y=v=>T+(H-T-B)*(1-Math.min(v,mx)/mx);
    for(let i=0;i<=4;i++){const v=mx*i/4;el('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),stroke:'var(--grid)'},svg);const tx=el('text',{x:L-5,y:y(v)+4,'text-anchor':'end'},svg);tx.textContent=fmt(v,0)}
    for(const t of[0,20,40,60,80,95]){const tx=el('text',{x:x(t),y:H-4,'text-anchor':'middle'},svg);tx.textContent=t+' s'}
    el('rect',{x:x(80),y:T,width:x(95)-x(80),height:H-T-B,fill:'var(--grid)',opacity:.6},svg);
    let band='';s.forEach((p,i)=>band+=(i?'L':'M')+x(p.t)+','+y(p[idx][2]));for(let i=s.length-1;i>=0;i--)band+='L'+x(s[i].t)+','+y(s[i][idx][1]);
    el('path',{d:band+'Z',fill:'var(--band)'},svg);
    let line='';s.forEach((p,i)=>line+=(i?'L':'M')+x(p.t)+','+y(p[idx][0]));
    el('path',{d:line,fill:'none',stroke:'var(--s1)','stroke-width':2,'stroke-linejoin':'round'},svg);
    const cross=el('line',{y1:T,y2:H-B,stroke:'var(--muted)','stroke-dasharray':'3 3',visibility:'hidden'},svg);
    const hit=el('rect',{x:L,y:T,width:W-L-R,height:H-T-B,class:'hit'},svg);
    hit.addEventListener('mousemove',e=>{const r=svg.getBoundingClientRect();const tt=(e.clientX-r.left)/r.width*W;const t=Math.round((tt-L)/(W-L-R)*95);
      const p=s.find(q=>q.t===t)||s.reduce((a,b)=>Math.abs(b.t-t)<Math.abs(a.t-t)?b:a);cross.setAttribute('x1',x(p.t));cross.setAttribute('x2',x(p.t));cross.setAttribute('visibility','visible');
      showTip(e,`<b>${m[1]}</b>, t = ${p.t} s<br>${title}: median <b>${fmt(p[idx][0],1)}</b> ${unit}<br>range ${fmt(p[idx][1],1)} to ${fmt(p[idx][2],1)}`)});
    hit.addEventListener('mouseleave',()=>{hideTip();cross.setAttribute('visibility','hidden')});
    card.appendChild(svg);host.appendChild(card);
  }
}

// Network: stacked bars of median KB uploaded per destination.
function network(){
  const host=document.getElementById('net');const dests=[['backend','Demo backend (app API calls)','var(--s1)'],['sentry','Sentry envelopes','var(--s2)'],['otlp','ouo OTLP (traces, logs)','var(--s3)'],['replay','ouo replay chunks','var(--s4)']];
  const lg=document.createElement('div');lg.className='legend';lg.innerHTML=dests.map(d=>`<span><i style="background:${d[2]}"></i>${d[1]}</span>`).join('');host.appendChild(lg);
  const W=900,L=200,R=90,rowH=34,H=MODES.length*rowH+26;const svg=el('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':'Upload by destination'});
  let mx=0;for(const m of MODES){const n=D.modes[m[0]]?.net||{};mx=Math.max(mx,dests.reduce((a,d)=>a+(n[d[0]]?.sent||0),0)/1024)}mx=niceMax(mx);
  const x=v=>L+(W-L-R)*v/mx;
  for(let i=0;i<=4;i++){const v=mx*i/4;el('line',{x1:x(v),x2:x(v),y1:4,y2:H-20,stroke:'var(--grid)'},svg);const t=el('text',{x:x(v),y:H-5,'text-anchor':'middle'},svg);t.textContent=fmt(v,0)+' KB'}
  MODES.forEach((m,i)=>{const n=D.modes[m[0]]?.net||{};const y=8+i*rowH;let acc=0;
    const lab=el('text',{x:L-8,y:y+rowH/2+2,'text-anchor':'end'},svg);lab.textContent=m[1];
    for(const d of dests){const v=(n[d[0]]?.sent||0)/1024;if(!v)continue;const w=Math.max(0,x(acc+v)-x(acc)-2);
      const r=el('rect',{x:x(acc),y:y+4,width:w,height:rowH-12,rx:3,fill:d[2]},svg);
      r.addEventListener('mousemove',e=>showTip(e,`<b>${m[1]}</b><br>${d[1]}: <b>${fmt(v,0)} KB</b> up, ${fmt((n[d[0]].recv||0)/1024,1)} KB down, ${fmt(n[d[0]].req,0)} requests (medians)`));r.addEventListener('mouseleave',hideTip);acc+=v}
    const tot=el('text',{x:x(acc)+6,y:y+rowH/2+2},svg);tot.textContent=fmt(acc,0)+' KB';tot.style.fill='var(--ink)'});
  host.appendChild(svg);
}
strips();series('cpu',0,'CPU','% of one core');series('mem',1,'phys_footprint','MB');network();
"""


def series_median(runs):
    """[{t, [[med,min,max] cpu], [[med,min,max] mem]}] across runs, per second."""
    by = {}
    for r in runs:
        for t, c, m in r["series"]:
            by.setdefault(t, ([], []))
            by[t][0].append(c)
            by[t][1].append(m)
    out = []
    for t in sorted(by):
        cs, ms = by[t]
        if len(cs) < max(1, len(runs) // 2):
            continue
        cs, ms = sorted(cs), sorted(ms)
        med = lambda v: v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
        out.append({"t": t, "0": [med(cs), cs[0], cs[-1]], "1": [med(ms), ms[0], ms[-1]]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--summary", required=True)
    ap.add_argument("--notes", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    s = json.load(open(a.summary))
    notes = open(a.notes).read()
    modes = s["modes"]
    ser = {}
    for k, _, _ in MODES:
        rs = [r for r in s["runs"] if r["mode"] == k]
        if rs:
            ser[k] = [{"t": p["t"], 0: p["0"], 1: p["1"]} for p in series_median(rs)]
    data = {"modes": {k: {**{m: modes[k][m] for m in modes[k]}} for k in modes}, "modesMeta": [list(m) for m in MODES if m[0] in modes],
            "metrics": [list(m) for m in METRICS], "series": ser}

    def med(mode, key):
        g = modes.get(mode, {}).get(key)
        return g["median"] if g else None

    def delta_tile(label, key, unit, prec, a_mode, b_mode, note):
        va, vb = med(a_mode, key), med(b_mode, key)
        pg = s.get("paired", {}).get(f"{b_mode}-{a_mode}", {}).get(key)
        if va is None or vb is None or not pg:
            return ""
        return (f'<div class="tile"><div class="k">{html.escape(label)}</div><div class="v">{(pg["median"] if abs(pg["median"]) >= 0.5 * 10 ** -prec else 0):+.{prec}f} {unit}</div>'
                f'<div class="d">paired median of {pg["n"]} rounds, range {pg["min"]:+.{prec}f} to {pg["max"]:+.{prec}f}. '
                f'Mode medians {vb:.{prec}f} vs {va:.{prec}f}. {note}</div></div>')

    tiles_off = "".join([
        delta_tile("CPU, journey", "cpu_pct", "pp", 1, "sentry", "both", "Percentage points of one core."),
        delta_tile("CPU, idle", "idle_cpu_pct", "pp", 1, "sentry", "both", "No taps, app in front."),
        delta_tile("Memory, steady", "steady_mb", "MB", 1, "sentry", "both", ""),
        delta_tile("App start", "start_ms", "ms", 1, "sentry", "both", "JS start to first frame."),
        delta_tile("SDK upload", "sdk_sent_kb", "KB", 0, "sentry", "both", "Per 95 s run."),
        delta_tile("SDK requests", "sdk_req", "", 0, "sentry", "both", "Per 95 s run."),
        delta_tile("JS frames dropped", "dropped", "", 0, "sentry", "both", "Per run."),
    ])
    tiles_on = "".join([
        delta_tile("CPU, journey", "cpu_pct", "pp", 1, "sentry", "both-replay", ""),
        delta_tile("CPU, idle", "idle_cpu_pct", "pp", 1, "sentry", "both-replay", ""),
        delta_tile("Memory, steady", "steady_mb", "MB", 1, "sentry", "both-replay", ""),
        delta_tile("Memory, peak", "peak_mb", "MB", 1, "sentry", "both-replay", ""),
        delta_tile("SDK upload", "sdk_sent_kb", "KB", 0, "sentry", "both-replay", "Per 95 s run."),
        delta_tile("JS frames dropped", "dropped", "", 0, "sentry", "both-replay", "Per run."),
    ])

    rows = []
    for key, title, unit, prec in METRICS + [("req", "All requests (incl. app API calls)", "per run", 0), ("premain_s", "Process start to JS start (simulator)", "s", 2)]:
        cells = []
        for k, _, _ in MODES:
            g = modes.get(k, {}).get(key)
            cells.append(f'<td>{g["median"]:.{prec}f}<span class="r">{g["min"]:.{prec}f} to {g["max"]:.{prec}f}</span></td>' if g else "<td>-</td>")
        rows.append(f"<tr><td>{html.escape(title)}<span class='r'>{html.escape(unit)}</span></td>{''.join(cells)}</tr>")
    n = {k: modes[k]["cpu_s"]["n"] for k in modes}
    head = "".join(f"<th>{html.escape(lbl)}<span class='r'>n = {n.get(k, 0)}</span></th>" for k, lbl, _ in MODES)

    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SDK overhead on iOS</title><style>{CSS}</style></head><body><main>
<h1>Running @ouo/react-native next to @sentry/react-native: what it costs on the device</h1>
<p class="sub">examples/sentry-mobile, iOS 27 simulator (iPhone 18 Pro) on an Apple M5 Mac, Release build, same binary for every mode, scripted real-tap journey of 95 s, {sum(n.values())} runs interleaved across modes. Generated by <code>examples/sentry-mobile/scripts/perf/report.py</code>; method in <code>kb/sdk-overhead-ios.md</code>.</p>
<h2 style="border:0;margin-top:16px">What adding ouo (replay off) to an app on Sentry costs</h2>
<p class="muted">"Sentry + ouo, ouo replay off" minus "Sentry only", run against run within each round (every round runs all modes back to back), then the median of the rounds.</p>
<div class="tiles">{tiles_off}</div>
<h3>And with ouo replay on as well (two screen recorders)</h3>
<div class="tiles">{tiles_on}</div>
{notes}
<h2>Every run, every metric</h2>
<p class="muted">One dot per run, the bar is the median, the pale band the min to max. Hover a row for the values.</p>
<div class="grid2" id="strips"></div>
<h2>CPU over the run</h2>
<p class="muted">CPU % of one core per second since process start, from the first second after JS start. Taps from 6 s to 74 s; the shaded strip (80 to 95 s) is the idle tail used for the idle CPU and steady memory numbers. The start-up burst (up to two cores in the first seconds) is clipped at the top of the scale; hover shows the values.</p>
<div class="grid2" id="cpu"></div>
<h2>Memory over the run</h2>
<p class="muted">phys_footprint (what Xcode's memory gauge and jetsam use), MB.</p>
<div class="grid2" id="mem"></div>
<h2>Network: what each mode uploads</h2>
<p class="muted">Median KB sent per 95 s run (HTTP request line, headers and body as the app sent them), split by destination. App API calls grow too with an SDK on: trace headers (<code>traceparent</code>, <code>baggage</code>, <code>sentry-trace</code>) ride on every backend request.</p>
<div class="card" id="net"></div>
<h2>Table</h2>
<p class="muted">Median, with min to max under it.</p>
<div class="scroll"><table><thead><tr><th>Metric</th>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table></div>
</main><div id="tip" role="tooltip"></div>
<script id="data" type="application/json">{json.dumps(data, separators=(",", ":")).replace("</", "<\\/")}</script>
<script>{JS}</script></body></html>"""
    with open(a.out, "w") as f:
        f.write(page)
    print(a.out)


if __name__ == "__main__":
    main()
