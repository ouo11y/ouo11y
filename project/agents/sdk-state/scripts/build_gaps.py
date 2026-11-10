"""Joins the four audit files with Step 4's Sentry vendor rows into findings/gaps.json: per Must and
Should feature and platform, our state, Sentry's state, and the gap size. Effort comes from
findings/effort.json. Run from anywhere: python3 project/agents/sdk-state/scripts/build_gaps.py"""
import json, re, pathlib
repo = pathlib.Path(__file__).resolve().parents[4]
data = repo / 'project/agents/sdk-state/findings'
def rows(path):
    out = {}
    for l in open(path):
        c = [s.strip() for s in l.split('|')]
        if len(c) > 4 and re.match(r'^[A-Z]+-[a-z0-9]+$', c[1]): out[c[1]] = c[2:-1]
    return out
def norm(v):
    v = v.lower()
    if v.startswith('—') or v.startswith('-'): return 'none'
    if v.startswith('via native'): return 'full'
    for k in ('partial', 'yes', 'no', 'n/a', 'uncertain'):
        if v.startswith(k): return {'yes': 'full', 'no': 'none', 'n/a': 'na'}.get(k, k)
    return 'unknown'
kb = repo / 'project/kb/client-sdk-features'
sw, sm = rows(kb / 'vendors/sentry-web.md'), rows(kb / 'vendors/sentry-mobile.md')
features = json.load(open(data / 'features.json'))
effort = json.load(open(data / 'effort.json'))
audits = {p: {f['id']: f for f in json.load(open(data / f'audit-{p}.json'))['features']} for p in ('web', 'ios', 'android', 'rn')}
def applies(where, p):
    w = where.replace(' ', '')
    return w == 'all' or (p == 'web' and 'W' in w.split(',')) or (p != 'web' and 'M' in w.split(',')) or \
        (p == 'ios' and 'iOS' in w) or (p == 'android' and 'Android' in w) or (p == 'rn' and 'RN' in w)
rank = {'full': 2, 'partial': 1, 'none': 0}
out = []
for f in features:
    if f['target'] not in ('Must', 'Should'): continue
    row = {**f, 'effort': effort.get(f['id'], {}), 'platforms': {}}
    for p in ('web', 'ios', 'android', 'rn'):
        if not applies(f['where'], p): continue
        ours = audits[p].get(f['id'], {'state': 'unknown', 'note': 'not graded', 'evidence': []})
        if p == 'web': s = norm(sw.get(f['id'], ['unknown'])[0]); snote = ' | '.join(sw.get(f['id'], [''])[1:3])
        else:
            m = sm.get(f['id']); i = ('ios', 'android', 'rn').index(p)
            s = norm(m[i]) if m else 'unknown'; snote = m[3] if m and len(m) > 3 else ''
        o = ours['state']
        if s in rank and o in rank:
            d = rank[s] - rank[o]
            gap = 'large' if d == 2 else 'medium' if d == 1 else 'ahead' if d < 0 else ('target' if o != 'full' else 'none')
        else: gap = 'unknown'
        row['platforms'][p] = {'ours': o, 'ours_note': ours.get('note', ''), 'ours_evidence': ours.get('evidence', []), 'sentry': s, 'sentry_note': snote[:300], 'gap': gap}
    out.append(row)
json.dump(out, open(data / 'gaps.json', 'w'), indent=1)
from collections import Counter
print(Counter(v['gap'] for r in out for v in r['platforms'].values()))
