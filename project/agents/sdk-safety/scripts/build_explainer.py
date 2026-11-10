#!/usr/bin/env python3
"""Build project/kb/client-sdk-safety/golden-rule.html from the Markdown entries.

Edit the Markdown, then run: python3 -I project/agents/sdk-safety/scripts/build_explainer.py
"""
import html
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[4]
KB = ROOT / "project/kb/client-sdk-safety"


def rows(text, prefix):
    out = []
    for line in text.splitlines():
        if line.startswith("| " + prefix):
            out.append([c.strip() for c in line.strip().strip("|").split("|")])
    return out


def md_inline(s):
    s = html.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", s)
    return s


checklist_md = (KB / "checklist/golden-rule-checklist.md").read_text()
cats, items, cat = [], [], None
for line in checklist_md.splitlines():
    m = re.match(r"## (\d+)\. (.+)", line)
    if m:
        cat = m.group(2)
        cats.append(cat)
    elif line.startswith("| GR-"):
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        items.append({"id": c[0], "cat": cat, "rule": md_inline(c[1]), "why": c[2],
                      "plat": c[3], "test": md_inline(c[4])})

catalog = (KB / "incidents/catalog.md").read_text()
guide = (KB / "incidents/vendor-guidance.md").read_text()
src = {}
for c in rows(catalog, "INC-"):
    src[c[0]] = {"t": f"{c[2]} ({c[1]}): {c[3]}", "u": c[6]}
for c in rows(catalog, "OUO-"):
    src[c[0]] = {"t": f"ouo: {c[1]} [{c[2]}]", "u": ""}
for c in rows(guide, "GUIDE-"):
    src[c[0]] = {"t": f"{c[1]}: {c[2]}", "u": c[3]}

grades_md = (KB / "grades/current-sdks.md").read_text()
grades = []
for line in grades_md.splitlines():
    m = re.match(r"\| (\d+) ([A-Z][^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|", line)
    if m:
        grades.append([m.group(1) + " " + m.group(2).strip()] +
                      [m.group(i).strip().replace("*", "") for i in range(3, 7)])

data = json.dumps({"cats": cats, "items": items, "src": src, "grades": grades})

page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SDK Golden Rule</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#66625a;--line:#e3dfd6;--card:#fff;--acc:#b4441c;--p:#2f7d4f;--pa:#a87508;--f:#b3261e;--na:#8a8a8a}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161513;--fg:#ecebe6;--mut:#a29d93;--line:#34312c;--card:#1f1d1a;--acc:#f08a5d;--p:#5cc489;--pa:#e0b040;--f:#ff7a70}}
:root[data-theme=dark]{--bg:#161513;--fg:#ecebe6;--mut:#a29d93;--line:#34312c;--card:#1f1d1a;--acc:#f08a5d;--p:#5cc489;--pa:#e0b040;--f:#ff7a70}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{margin:40px 0 8px;font-size:20px}
.rule{border-left:4px solid var(--acc);background:var(--card);padding:16px 20px;margin:20px 0;font-size:17px}
.mut{color:var(--mut)}code{font:13px ui-monospace,Menlo,monospace;background:var(--line);padding:0 4px;border-radius:3px}
table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
th{font-size:13px;color:var(--mut);font-weight:600}.g{font-weight:700;text-align:center}.gP{color:var(--p)}.gPa{color:var(--pa)}.gF{color:var(--f)}.gna,.gq{color:var(--na)}
.wrap{overflow-x:auto}.ctl{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}select,input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit}
input{flex:1;min-width:180px}.id{font:600 12px ui-monospace,Menlo,monospace;white-space:nowrap}.why a{color:var(--acc)}.why span{display:block;font-size:13px}
@media (max-width:700px){.items thead{display:none}.items tr{display:block;border-bottom:1px solid var(--line);padding:8px 0}.items td{display:block;border:0;padding:2px 8px}}
</style></head><body><main>
<h1>The app must not pay for the SDK's failures</h1>
<p class="mut">ouo client SDK golden rule &middot; checklist researched 2026-11-10 &middot; generated from <code>project/kb/client-sdk-safety/</code></p>
<div class="rule">When the SDK fails (a bug, a bad config, a dead network, a full disk, a broken backend, a hostile page, an OS change), the host app keeps working exactly as it would without the SDK: no crash, no hang, no slowdown the user can feel, no changed request, no leaked secret, no lost handler. The SDK loses telemetry before the app loses anything.</div>
<h2>Where our SDKs stand</h2>
<p class="mut">P pass, Pa partial, F fail, n/a not applicable, ? not measured. Evidence with <code>file:line</code> is in <code>grades/current-sdks.md</code>.</p>
<div class="wrap"><table id="grades"><thead><tr><th>Category</th><th>Web</th><th>React Native</th><th>iOS</th><th>Android</th></tr></thead><tbody></tbody></table></div>
<h2>The checklist</h2>
<div class="ctl"><select id="fc"><option value="">All categories</option></select><select id="fp"><option value="">All platforms</option><option>W</option><option>RN</option><option>iOS</option><option>And</option><option>Fl</option></select><input id="fq" placeholder="Search rules, tests, incidents"></div>
<p class="mut" id="count"></p>
<div class="wrap"><table class="items"><thead><tr><th>Id</th><th>MUST</th><th>Motivated by</th><th>Platforms</th><th>Automated test</th></tr></thead><tbody id="tb"></tbody></table></div>
</main>
<script>
const D=__DATA__;
const gb=document.querySelector('#grades tbody');
for(const r of D.grades){const tr=document.createElement('tr');tr.innerHTML='<td>'+r[0]+'</td>'+r.slice(1).map(v=>{const k=v==='n/a'?'na':v==='?'?'q':v;return '<td class="g g'+k+'">'+v+'</td>'}).join('');gb.appendChild(tr)}
const fc=document.getElementById('fc');D.cats.forEach(c=>{const o=document.createElement('option');o.textContent=c;fc.appendChild(o)});
function esc(s){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function why(w){return w.split(/,\\s*/).map(t=>{const s=D.src[t.trim()];if(!s)return '<span>'+esc(t)+'</span>';return '<span><b>'+esc(t.trim())+'</b> '+(s.u?'<a href="'+esc(s.u)+'" rel="noopener">'+esc(s.t)+'</a>':esc(s.t))+'</span>'}).join('')}
function plat(p,f){if(!f)return true;return p==='all'||p.split(/,\\s*/).some(x=>x===f||(x==='all with replay'))}
function draw(){const c=fc.value,p=document.getElementById('fp').value,q=document.getElementById('fq').value.toLowerCase();const tb=document.getElementById('tb');tb.innerHTML='';let n=0;
for(const i of D.items){if(c&&i.cat!==c)continue;if(!plat(i.plat,p))continue;if(q&&!(i.id+i.rule+i.test+i.why).toLowerCase().includes(q))continue;n++;
const tr=document.createElement('tr');tr.innerHTML='<td class="id">'+i.id+'</td><td>'+i.rule+'</td><td class="why">'+why(i.why)+'</td><td>'+esc(i.plat)+'</td><td>'+i.test+'</td>';tb.appendChild(tr)}
document.getElementById('count').textContent=n+' of '+D.items.length+' items'}
['fc','fp','fq'].forEach(id=>document.getElementById(id).addEventListener('input',draw));draw();
</script></body></html>
"""
(KB / "golden-rule.html").write_text(page.replace("__DATA__", data))
print(f"{len(items)} items, {len(grades)} grade rows, {len(src)} sources")
