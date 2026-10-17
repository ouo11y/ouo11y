#!/usr/bin/env python3
"""Attribute app CPU in an Instruments Time Profiler trace to Sentry, ouo and the rest.

    xcrun xctrace record --template 'Time Profiler' --device <udid> --attach <pid> --time-limit 85s --output tp.trace
    xcrun xctrace export --input tp.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > tp.xml
    python3 -I profile.py tp.xml

Sentry (sentry-cocoa, RNSentry) and ouo (OuoReplay, OuoReactNative) are linked statically into the
app binary, so samples are classified by symbol name: a sample counts for Sentry when any frame of its
backtrace names a Sentry symbol, for ouo when any frame names an ouo symbol (inclusive, like
Instruments' "Involves Symbol" filter). JavaScript run by Hermes (both SDKs' JS layers, the app) shows
as Hermes interpreter frames on the JS thread and cannot be split per SDK this way: it is reported per
thread instead.
"""
import collections
import re
import sys
import xml.etree.ElementTree as ET

SENTRY = re.compile(r"sentry", re.I)
# ouo's Swift types carry no common prefix in demangled names: match the module and type names of
# sdk/ios (OuoReplay, OuoReplayCore) and the Expo module.
OUO = re.compile(r"Ouo|\b(ScreenCapturer|ReplayRecorder|TouchObserver|ViewTreeBuilder|ChunkBuilder|ChunkUploader|"
                 r"FrameDeduper|RedactionPlanner|UserDefaultsSeqStore|InMemorySeqStore|URLSessionTransport|SessionIdBox)\b")


def main():
    root = ET.parse(sys.argv[1]).getroot()
    byid = {}
    for e in root.iter():
        if "id" in e.attrib:
            byid[e.attrib["id"]] = e

    def deref(e):
        return byid.get(e.attrib["ref"], e) if e is not None and "ref" in e.attrib else e

    total = 0
    buckets = collections.Counter()
    threads = collections.Counter()
    top = {"sentry": collections.Counter(), "ouo": collections.Counter()}
    leafbin, anybin = collections.Counter(), collections.Counter()
    for row in root.iter("row"):
        w = deref(row.find("weight"))
        weight = int(w.text) if w is not None and w.text else 1_000_000
        th = deref(row.find("thread"))
        tname = th.attrib.get("fmt", "?") if th is not None else "?"
        tname = re.sub(r"0x[0-9a-f]+", "", tname).split("(")[0].strip() or "?"
        bt = deref(row.find("backtrace"))
        if bt is None:
            bt = deref(row.find("tagged-backtrace"))
        names, bins = [], []
        if bt is not None:
            for f in bt.findall("frame"):
                f = deref(f)
                names.append(f.attrib.get("name", ""))
                b = deref(f.find("binary"))
                bins.append(b.attrib.get("name", "") if b is not None else "")
        total += weight
        threads[tname] += weight
        leafbin[bins[0] if bins else "?"] += weight
        for b in set(bins):
            anybin[b] += weight
        is_s = any(SENTRY.search(n) for n in names)
        is_o = any(OUO.search(n) for n in names)
        if is_s:
            buckets["sentry (native, inclusive)"] += weight
            top["sentry"][next(n for n in names if SENTRY.search(n))] += weight
        if is_o:
            buckets["ouo (native, inclusive)"] += weight
            top["ouo"][next(n for n in names if OUO.search(n))] += weight
        if not is_s and not is_o:
            buckets["other"] += weight
    print(f"total sampled CPU {total / 1e9:.2f} s")
    for k, v in buckets.most_common():
        print(f"  {k:30} {v / 1e9:6.2f} s  {100 * v / total:5.1f} %")
    print("threads:")
    for k, v in threads.most_common(12):
        print(f"  {k[:60]:60} {v / 1e9:6.2f} s  {100 * v / total:5.1f} %")
    print("leaf binary (self time):")
    for k, v in leafbin.most_common(12):
        print(f"  {k[:60]:60} {v / 1e9:6.2f} s  {100 * v / total:5.1f} %")
    print("binary anywhere in the backtrace (inclusive):")
    for k, v in anybin.most_common(25):
        print(f"  {k[:60]:60} {v / 1e9:6.2f} s  {100 * v / total:5.1f} %")
    for k in ("sentry", "ouo"):
        print(f"top {k} frames (first matching frame from the leaf):")
        for n, v in top[k].most_common(8):
            print(f"  {n[:90]:90} {v / 1e9:6.2f} s")


if __name__ == "__main__":
    main()
