#!/usr/bin/env python3
"""Per-capture main-thread time of each replay recorder, from an Instruments Time Profiler export.

    xcrun xctrace export --input tps.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > tps.xml
    python3 -I capture_stalls.py tps.xml [--json out.json] [--gap-ms 4] [--process sentrydemo]

A capture is a burst of main-thread samples whose backtrace names the recorder's capture code (ouo:
`ReplayRecorder.captureFrame` and what it calls; Sentry: the session replay's screenshot path).
Samples closer than --gap-ms (50) belong to the same capture: one capture shows 3-8 ms holes where
the main thread is descheduled or blocked inside drawHierarchy, while two captures are at least
250 ms apart (ouo: 1 s timer, at most 4 touch captures per second; Sentry: 1 frame per second).
Per capture:
  cpu_ms   sum of sample weights (1 ms per sample at the default Time Profiler interval): main-thread
           CPU the capture used.
  wall_ms  first to last sample plus one interval: how long the main thread was unavailable,
           including the holes. This is the number that compares with a frame budget.
Applied the same way to both SDKs, so the numbers compare on one trace.
"""
import argparse
import json
import re
import statistics
import xml.etree.ElementTree as ET

RECORDERS = {
    # ouo: the capture entry point; ScreenCapturer/ViewTreeBuilder only run inside it.
    "ouo": re.compile(r"ReplayRecorder\.captureFrame|ReplayRecorder\.capture\(|ScreenCapturer\.(capture|snapshot)|ViewTreeBuilder"),
    # Sentry (sentry-cocoa 8.x/9.x): SentrySessionReplay.newFrame -> takeScreenshot ->
    # SentryViewPhotographer.image(view:) (redaction regions + render on the main thread).
    "sentry": re.compile(r"SentryViewPhotographer|SentrySessionReplay\.(newFrame|takeScreenshot)|SentryViewScreenshotProvider|SentryGraphicsImageRenderer"),
}


def parse(path):
    root = ET.parse(path).getroot()
    byid = {e.attrib["id"]: e for e in root.iter() if "id" in e.attrib}

    def deref(e):
        return byid.get(e.attrib["ref"], e) if e is not None and "ref" in e.attrib else e

    for row in root.iter("row"):
        t = deref(row.find("sample-time"))
        w = deref(row.find("weight"))
        th = deref(row.find("thread"))
        bt = deref(row.find("backtrace"))
        if bt is None:
            bt = deref(row.find("tagged-backtrace"))
            if bt is not None and bt.find("backtrace") is not None:
                bt = deref(bt.find("backtrace"))
        names = []
        if bt is not None:
            for f in bt.iter("frame"):
                names.append(deref(f).attrib.get("name", ""))
        tname = th.attrib.get("fmt", "") if th is not None else ""
        yield int(t.text), int(w.text) if w is not None and w.text else 1_000_000, tname, names


def bursts(samples, gap_ns):
    """[(cpu_ns, wall_ns)] per capture."""
    out, cur, first, last, lastw = [], 0, None, None, 0
    for t, w in samples:
        if last is not None and t - last > gap_ns:
            out.append((cur, last - first + lastw))
            cur, first = 0, None
        if first is None:
            first = t
        cur += w
        last, lastw = t, w
    if cur:
        out.append((cur, last - first + lastw))
    return out


def pct(values, p):
    s = sorted(values)
    return s[min(len(s) - 1, int(round(p / 100 * (len(s) - 1))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xml")
    ap.add_argument("--gap-ms", type=float, default=50)
    ap.add_argument("--json")
    ap.add_argument("--process", help="only threads of this process (the thread label names it)")
    a = ap.parse_args()
    per = {k: [] for k in RECORDERS}
    main_total = 0
    for t, w, tname, names in parse(a.xml):
        if "Main Thread" not in tname or (a.process and a.process not in tname):
            continue
        main_total += w
        for k, rx in RECORDERS.items():
            if any(rx.search(n) for n in names):
                per[k].append((t, w))
    result = {"main_thread_sampled_ms": main_total / 1e6}
    for k, samples in per.items():
        samples.sort()
        b = bursts(samples, a.gap_ms * 1e6)
        if not b:
            result[k] = {"captures": 0}
            print(f"{k:7} no samples")
            continue
        r = {"captures": len(b)}
        for name, values in (("cpu", [c / 1e6 for c, _ in b]), ("wall", [w / 1e6 for _, w in b])):
            r[name] = {
                "median_ms": statistics.median(values),
                "p25_ms": pct(values, 25),
                "p75_ms": pct(values, 75),
                "p95_ms": pct(values, 95),
                "max_ms": max(values),
                "total_ms": sum(values),
                "over_16ms": sum(1 for v in values if v > 1000 / 60),
                "values": [round(v, 1) for v in values],
            }
            x = r[name]
            print(f"{k:7} {name:4} captures {len(b):4}  median {x['median_ms']:5.1f} ms  p25 {x['p25_ms']:5.1f}  p75 {x['p75_ms']:5.1f}  "
                  f"p95 {x['p95_ms']:5.1f}  max {x['max_ms']:5.1f}  >16.7ms {x['over_16ms']:3}  total {x['total_ms']:6.0f} ms")
        result[k] = r
    if a.json:
        with open(a.json, "w") as f:
            json.dump(result, f, indent=1)


if __name__ == "__main__":
    main()
