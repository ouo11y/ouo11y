#!/usr/bin/env python3
"""Durations of ouo's replay signpost intervals (subsystem dev.ouo.replay) from an xctrace export.

    xcrun xctrace export --input tps.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="os-signpost"]' > os-signpost.xml
    python3 -I signposts.py os-signpost.xml [--json out.json]

`snapshot` is the main-thread part of a capture (view walk + drawHierarchy), `compose` the
capture-queue part (redaction, thumbnail, JPEG, chunking). Begin and End are paired by signpost id.
"""
import argparse
import collections
import json
import statistics
import xml.etree.ElementTree as ET


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xml")
    ap.add_argument("--subsystem", default="dev.ouo.replay")
    ap.add_argument("--json")
    a = ap.parse_args()
    root = ET.parse(a.xml).getroot()
    byid = {e.attrib["id"]: e for e in root.iter() if "id" in e.attrib}

    def deref(e):
        return byid.get(e.attrib["ref"], e) if e is not None and "ref" in e.attrib else e

    open_ = {}
    durations = collections.defaultdict(list)
    for row in root.iter("row"):
        sub = deref(row.find("subsystem"))
        if sub is None or sub.text != a.subsystem:
            continue
        t = int(deref(row.find("event-time")).text)
        kind = deref(row.find("event-type")).text
        name = deref(row.find("signpost-name")).text
        ident = deref(row.find("os-signpost-identifier")).text
        if kind == "Begin":
            open_[(name, ident)] = t
        elif kind == "End" and (name, ident) in open_:
            durations[name].append((t - open_.pop((name, ident))) / 1e6)
    out = {}
    for name in sorted(durations):
        v = sorted(durations[name])
        q = lambda p: v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]
        out[name] = {"n": len(v), "median_ms": statistics.median(v), "p25_ms": q(25), "p75_ms": q(75), "p95_ms": q(95), "max_ms": v[-1],
                     "over_16ms": sum(1 for x in v if x > 1000 / 60), "values": [round(x, 2) for x in v]}
        r = out[name]
        print(f"{name:20} n {r['n']:4}  median {r['median_ms']:6.2f} ms  p25 {r['p25_ms']:6.2f}  p75 {r['p75_ms']:6.2f}  p95 {r['p95_ms']:6.2f}  max {r['max_ms']:6.2f}  >16.7ms {r['over_16ms']}")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
