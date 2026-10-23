#!/usr/bin/env python3
"""App binary and JS bundle bytes added by each SDK, from one Release build (build.sh output).

    python3 -I size.py --build <build.sh out dir> --json size.json

The benchmark runs one binary for every cell, so "size added" is attributed inside that binary,
not measured as the difference of separate builds:

  native   the link map (`LD_GENERATE_MAP_FILE`) lists every symbol's size with the object file it
           came from; object files are grouped by library path (`libRNSentry.a(...)`,
           `.../OuoReplay/...`). Embedded frameworks (`Frameworks/*.framework`, e.g. the prebuilt
           Sentry.xcframework) are counted by their files in the .app.
  js       the Hermes bytecode bundle (`main.jsbundle`) with its composed source map: each mapping
           segment covers the bytes up to the next segment, attributed to its source's npm package.
           Hermes's header and shared string tables map to no source and are left unattributed
           (`attributed_bytes` < `bundle_bytes`), so the JS numbers are function bytecode only.
           Packages are grouped per SDK, with each SDK's own dependencies (OpenTelemetry for ouo,
           @sentry-internal / @sentry/core for Sentry).
Uncompressed sizes in the .app; the App Store download is compressed and thinned, so the store
size added is smaller than these numbers, by about the same factor for both SDKs.
"""
import argparse
import collections
import json
import os
import re

B64 = {c: i for i, c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")}

# Native groups, matched against the library name (static archive or framework; never the full path:
# the app itself lives in examples/sentry-mobile). First match wins.
NATIVE = [
    ("sentry", re.compile(r"^(lib)?(RN)?Sentry", re.I)),
    ("ouo", re.compile(r"^(lib)?Ouo", re.I)),
]
# JS groups, matched against the npm package name of a source.
JS = [
    ("sentry", re.compile(r"^@sentry(-internal)?/")),
    ("ouo", re.compile(r"^(@ouo11y/|@opentelemetry/)")),
]


def classify(rules, name):
    for g, rx in rules:
        if rx.search(name):
            return g
    return "other"


def vlq(segment):
    out, shift, val = [], 0, 0
    for ch in segment:
        d = B64[ch]
        val += (d & 31) << shift
        if d & 32:
            shift += 5
        else:
            out.append(-(val >> 1) if val & 1 else val >> 1)
            shift, val = 0, 0
    return out


def package_of(src):
    m = re.search(r"node_modules/((@[^/]+/)?[^/]+)", src)
    if m:
        return m.group(1)
    if "sdk/react-native" in src:
        return "@ouo11y/react-native"
    return "(app)"


def js_attribution(bundle, smap):
    m = json.load(open(smap))
    size = os.path.getsize(bundle)
    sources = m["sources"]
    by_pkg = collections.Counter()
    src = 0
    prev = None  # (line, col, src)
    lines = m["mappings"].split(";")
    for li, line in enumerate(lines):
        col = 0
        for seg in filter(None, line.split(",")):
            f = vlq(seg)
            col += f[0]
            if len(f) >= 4:
                src += f[1]
            if prev and prev[0] == li:
                by_pkg[package_of(sources[prev[2]])] += col - prev[1]
            prev = (li, col, src) if len(f) >= 4 else None
    # The bytes after the last segment and before the first one (Hermes header, string and
    # identifier tables, shared by every function) are not attributed: reported as the remainder.
    attributed = sum(by_pkg.values())
    groups = collections.Counter()
    for p, n in by_pkg.items():
        groups[classify(JS, p)] += n
    return {"bundle_bytes": size, "attributed_bytes": attributed, "groups": dict(groups),
            "top_packages": by_pkg.most_common(25)}


def native_attribution(linkmap, app):
    objs, by_obj = {}, collections.Counter()
    section = None
    for line in open(linkmap, errors="replace"):
        if line.startswith("# Object files:"):
            section = "obj"
            continue
        if line.startswith("# Sections:"):
            section = "sect"
            continue
        if line.startswith("# Symbols:"):
            section = "sym"
            continue
        if line.startswith("# Dead Stripped Symbols:"):
            break
        if section == "obj":
            m = re.match(r"\[\s*(\d+)\]\s+(.*)", line)
            if m:
                objs[int(m.group(1))] = m.group(2).strip()
        elif section == "sym":
            m = re.match(r"0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)\s+\[\s*(\d+)\]", line)
            if m:
                by_obj[int(m.group(2))] += int(m.group(1), 16)
    groups, libs = collections.Counter(), collections.Counter()
    for i, n in by_obj.items():
        path = objs.get(i, "?")
        lib = re.sub(r"\(.*\)$", "", os.path.basename(path)) if "(" in path else os.path.basename(os.path.dirname(path)) or path
        groups[classify(NATIVE, lib)] += n
        libs[lib] += n
    frameworks = {}
    fw_dir = os.path.join(app, "Frameworks")
    if os.path.isdir(fw_dir):
        for fw in sorted(os.listdir(fw_dir)):
            total = 0
            for dp, _, fs in os.walk(os.path.join(fw_dir, fw)):
                total += sum(os.path.getsize(os.path.join(dp, f)) for f in fs)
            frameworks[fw] = total
            groups[classify(NATIVE, fw)] += total
    exe = os.path.join(app, "sentrydemo")
    return {"linked_bytes": sum(by_obj.values()), "executable_bytes": os.path.getsize(exe) if os.path.exists(exe) else None,
            "frameworks": frameworks, "groups": dict(groups), "top_libraries": libs.most_common(25)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", required=True)
    ap.add_argument("--json")
    a = ap.parse_args()
    app = os.path.join(a.build, "sentrydemo.app")
    out = {"app_bytes": sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(app) for f in fs)}
    lm = os.path.join(a.build, "linkmap.txt")
    if os.path.exists(lm):
        out["native"] = native_attribution(lm, app)
    sm = os.path.join(a.build, "main.jsbundle.map")
    if os.path.exists(sm):
        out["js"] = js_attribution(os.path.join(app, "main.jsbundle"), sm)
    for k in ("native", "js"):
        if k in out:
            g = out[k]["groups"]
            print(f"{k:6} " + "  ".join(f"{n} {v / 1024:,.0f} KB" for n, v in sorted(g.items())))
    print(f"app    {out['app_bytes'] / 2**20:.1f} MB")
    if a.json:
        json.dump(out, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
