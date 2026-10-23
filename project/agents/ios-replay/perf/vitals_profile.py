#!/usr/bin/env python3
"""Main-thread time spent in OuoVitals frames, from an exported Time Profiler table (checklist G2).

  xcrun xctrace record --template 'Time Profiler' --device <sim udid> --time-limit 30s \
    --output vitals.trace --launch -- <path to mobilestore.app>
  xcrun xctrace export --input vitals.trace \
    --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > tp.xml
  python3 -I vitals_profile.py tp.xml
"""
import sys, re, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
ids = {}
def reg(e):
    for x in e.iter():
        i = x.get('id')
        if i: ids[i] = x
reg(root)
def res(e): return ids.get(e.get('ref'), e) if e is not None and e.get('ref') else e
pat = re.compile(r'OuoVitals|DisplayLinkTracker|FrameCounter|UnfairLock|ouo_vitals|getFrameStats|getAppStartInfo')
tot = main = mainv = allv = 0
names = {}
for row in root.iter('row'):
    th = res(row.find('thread'))
    if th is None: continue
    w = res(row.find('weight')); wt = int(w.text) if w is not None else 1000000
    tot += wt
    ismain = 'Main Thread' in th.get('fmt','')
    bt = res(row.find('tagged-backtrace'))
    if bt is None: bt = res(row.find('backtrace'))
    frames = []
    if bt is not None:
        b2 = bt.find('backtrace'); b2 = res(b2) if b2 is not None else bt
        for f in b2.iter('frame'):
            f = res(f); frames.append(f.get('name',''))
    hit = any(pat.search(n) for n in frames)
    if hit:
        allv += wt
        for n in frames:
            if pat.search(n): names[n] = names.get(n,0)+wt; break
    if ismain:
        main += wt
        if hit: mainv += wt
ms = lambda v: v/1e6
print(f"process samples {ms(tot):.0f} ms, main thread {ms(main):.0f} ms, vitals frames on main {ms(mainv):.1f} ms ({100*mainv/max(main,1):.3f}% of main), vitals anywhere {ms(allv):.1f} ms")
for n,v in sorted(names.items(), key=lambda x:-x[1])[:10]: print(f"  {ms(v):6.1f} ms  {n[:120]}")
