#!/usr/bin/env python3
"""bench.py output -> result.json: per-run metrics, per-cell medians and IQR, paired deltas.

    python3 -I bench_result.py --out <bench.py out dir> [--size size.json] [--json result.json]

All times are absolute (epoch seconds): the journey's launch request (`PERF launch_request_ms`,
the test runner's clock = the device's), the app's JS start and first frame (perf.json, the
device's clock), recorder samples (simulator: host = device clock; device: xctrace times mapped to
the host clock) and proxy requests (host clock, cut by the run's host start/end).

Per main run:
  start_ms        JS start -> first frame after NavigationContainer.onReady. premain_s (simulator
                  only): kernel process start -> JS start.
  cpu_pct         CPU % of one core, JS start -> launch + 76 s (the journey). cpu_p95_pct: p95 of the
                  1 s windows in the same span. idle_cpu_pct: launch + 80 s -> launch + 95 s.
  peak_mb         peak phys_footprint; steady_mb: median footprint in the idle tail.
  net             per destination: requests, wire bytes up (as sent, compressed), decoded bytes up
                  (Content-Encoding removed), bytes down. sdk_* sums every destination but the
                  backend. replay_kb_min: replay uploads (ouo /v1/replay, Sentry envelopes with a
                  replay item) per minute of run.
  dropped_pct     JS frames dropped, against the refresh interval measured from the rAF histogram.
  disk_kb         app container after the run, by SDK (path names).
Soak: memory growth (MB/h, least squares over t >= 5 min, or the last 80 % of a shorter soak). Offline: disk and memory after a run with
SDK traffic refused; recover: SDK bytes sent by the next (online, idle) launch.
"""
import argparse
import glob
import json
import os
import re
import statistics
import xml.etree.ElementTree as ET

JOURNEY_END = 76.0
IDLE = (80.0, 95.0)

KEYS = ["start_ms", "premain_s", "cpu_pct", "cpu_p95_pct", "idle_cpu_pct", "peak_mb", "steady_mb", "sdk_req",
        "sdk_up_kb", "sdk_up_decoded_kb", "sdk_down_kb", "replay_kb_min", "backend_up_kb", "dropped", "dropped_pct", "long_frames",
        "disk_sentry_kb", "disk_ouo_kb", "energy_mj", "hitches", "hitch_ratio", "wakeups"]


# --------------------------------------------------------------------------------------------- samples


def sim_samples(d):
    p = os.path.join(d, "samples.json")
    if not os.path.exists(p):
        return None
    smp = json.load(open(p))
    st = smp["process_start"]
    s = [{"t": st + x["t"], "cpu_ns": x["cpu_ns"], "footprint": x["footprint"], "wakeups": x.get("wakeups", 0)} for x in smp["samples"]]
    peak = smp["samples"][-1]["lifetime_max_footprint"] if smp["samples"] else None
    return {"process_start": st, "samples": s, "peak": peak}


def _num(e):
    """xctrace export cells: the value is the text, or a `ref` to an earlier element with an id."""
    if e is None:
        return None
    try:
        return float(e.text)
    except (TypeError, ValueError):
        return None


def toc_start(d):
    p = os.path.join(d, "toc.xml")
    if not os.path.exists(p):
        return None
    txt = ET.parse(p).getroot().findtext(".//start-date")
    if not txt:
        return None
    from datetime import datetime
    return datetime.fromisoformat(txt.strip().replace("Z", "+00:00")).timestamp()


def device_samples(d):
    """xctrace Activity Monitor export (activity-monitor-process-live), rows of the sentrydemo process."""
    p = os.path.join(d, "activity-monitor-process-live.xml")
    if not os.path.exists(p):
        return None
    root = ET.parse(p).getroot()
    byid = {e.attrib["id"]: e for e in root.iter() if "id" in e.attrib}
    deref = lambda e: byid.get(e.attrib["ref"], e) if e is not None and "ref" in e.attrib else e
    schema = root.find(".//schema")
    cols = [c.findtext("mnemonic") for c in schema.findall("col")] if schema is not None else []
    meta = json.load(open(os.path.join(d, "meta.json")))
    rows = []
    for row in root.iter("row"):
        cells = [deref(c) for c in row]
        rec = dict(zip(cols, cells))
        proc = rec.get("process")
        name = (proc.attrib.get("fmt", "") if proc is not None else "")
        if "sentrydemo" not in name:
            continue
        t_ns = _num(rec.get("start"))
        cpu_time = _num(rec.get("cpu-total")) or _num(rec.get("cpu-time"))
        mem = _num(rec.get("memory-physical-footprint")) or _num(rec.get("memory-real")) or _num(rec.get("memory"))
        if t_ns is None:
            continue
        rows.append({"t_rel": t_ns / 1e9, "cpu_ns": cpu_time, "footprint": mem, "cpu_pct": _num(rec.get("cpu-percent")),
                     "wake": _num(rec.get("idle-wakeups")) or 0})
    if not rows:
        return None
    # Row times are relative to the recording's start, which the trace's TOC holds as an absolute date.
    t_zero = toc_start(d) or meta.get("recorder_t0")
    rows.sort(key=lambda r: r["t_rel"])
    cum, wake = 0.0, 0.0
    out = []
    prev = None
    for r in rows:
        if r["cpu_ns"] is None and r["cpu_pct"] is not None and prev is not None:
            cum += r["cpu_pct"] / 100 * (r["t_rel"] - prev) * 1e9
            r["cpu_ns"] = cum
        wake = r["wake"]  # cumulative since process start in the live table, like the simulator's counter
        out.append({"t": t_zero + r["t_rel"], "cpu_ns": r["cpu_ns"] or 0, "footprint": r["footprint"] or 0, "wakeups": wake})
        prev = r["t_rel"]
    return {"process_start": None, "samples": out, "peak": max(x["footprint"] for x in out)}


def at(s, t, key):
    prev = s[0]
    for x in s:
        if x["t"] >= t:
            if x is prev or x["t"] == prev["t"]:
                return x[key]
            f = (t - prev["t"]) / (x["t"] - prev["t"])
            return prev[key] + f * (x[key] - prev[key])
        prev = x
    return s[-1][key]


def cpu_pct(s, a, b):
    return 100 * (at(s, b, "cpu_ns") - at(s, a, "cpu_ns")) / 1e9 / (b - a) if b > a else None


def pctl(v, p):
    v = sorted(v)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


# --------------------------------------------------------------------------------------------- per run


def launch_time(d):
    for line in open(os.path.join(d, "steps.log"), errors="replace"):
        m = re.match(r"PERF launch_request_ms=(\d+)", line)
        if m:
            return int(m.group(1)) / 1000
    return None


def frames(perf):
    hist = {int(k): v for k, v in perf.get("hist", {}).items()}
    if not hist:
        return {}
    mode = max((k for k in hist if 4 <= k <= 40), key=lambda k: hist[k], default=17)
    near = {k: v for k, v in hist.items() if abs(k - mode) <= 1}
    frame_ms = sum(k * v for k, v in near.items()) / sum(near.values())
    n = sum(hist.values())
    dropped = sum(v * max(0, round(k / frame_ms) - 1) for k, v in hist.items())
    return {"refresh_hz": round(1000 / frame_ms), "frames": n, "dropped": dropped,
            "dropped_pct": 100 * dropped / (n + dropped) if n else None,
            "long_frames": sum(v for k, v in hist.items() if k > 50), "max_frame_ms": perf.get("maxDt")}


def disk(d):
    p = os.path.join(d, "disk.json")
    if not os.path.exists(p):
        return {}
    g = {"sentry": 0, "ouo": 0, "other": 0}
    files = json.load(open(p))["files"]
    for f in files:
        path = f["path"] or ""
        # The bundle id (dev.ouo.sentrydemo) names both SDKs: match on the rest of the path only.
        low = path.lower().replace("dev.ouo.sentrydemo", "")
        if "sentry" in low:
            g["sentry"] += f["size"]
        elif "ouo" in low:
            g["ouo"] += f["size"]
        elif "perf-mode.json" in low or "perf.json" in low:
            continue
        else:
            g["other"] += f["size"]
    return {"disk_sentry_kb": g["sentry"] / 1024, "disk_ouo_kb": g["ouo"] / 1024, "disk_other_kb": g["other"] / 1024,
            "disk_files": sorted(([f["path"], f["size"]] for f in files if f["size"] > 4096), key=lambda x: -x[1])[:20]}


def network(requests, meta):
    t0, t1 = meta["host_t0"] - 1, meta["host_t1"] + 1
    by, replay, backend_paths = {}, 0, []
    for r in requests:
        if not (t0 <= r["t"] <= t1):
            continue
        b = by.setdefault(r["label"], {"req": 0, "up": 0, "up_decoded": 0, "down": 0, "offline": 0})
        b["req"] += 1
        b["up"] += r["req_bytes"]
        dec = r.get("req_body_decoded")
        b["up_decoded"] += r["req_bytes"] - r.get("req_body", 0) + (dec if dec is not None else r.get("req_body", 0))
        b["down"] += r.get("resp_bytes", 0)
        b["offline"] += 1 if r.get("offline") else 0
        if r["label"] == "replay" or any(t.startswith("replay") for t, _ in r.get("items", [])):
            replay += r["req_bytes"]
        if r["label"] == "backend":
            backend_paths.append(f"{r['method']} {r['path'].split('?')[0]}{'?fail' if 'fail=' in r['path'] else ''} {r['status']}")
    sdk = {k: v for k, v in by.items() if k != "backend"}
    minutes = meta["seconds"] / 60
    return {"net": by, "sdk_req": sum(v["req"] for v in sdk.values()), "sdk_up_kb": sum(v["up"] for v in sdk.values()) / 1024,
            "sdk_up_decoded_kb": sum(v["up_decoded"] for v in sdk.values()) / 1024,
            "sdk_down_kb": sum(v["down"] for v in sdk.values()) / 1024, "replay_kb_min": replay / 1024 / minutes,
            "backend_up_kb": by.get("backend", {}).get("up", 0) / 1024, "backend_paths": sorted(backend_paths)}


def energy(d):
    """Power Profiler export: per-process energy rows of sentrydemo, summed (mJ)."""
    for name in ("power-profiler-process.xml",):
        p = os.path.join(d, name)
        if not os.path.exists(p):
            continue
        root = ET.parse(p).getroot()
        byid = {e.attrib["id"]: e for e in root.iter() if "id" in e.attrib}
        deref = lambda e: byid.get(e.attrib["ref"], e) if e is not None and "ref" in e.attrib else e
        cols = [c.findtext("mnemonic") for c in root.find(".//schema").findall("col")]
        total = 0.0
        for row in root.iter("row"):
            rec = dict(zip(cols, (deref(c) for c in row)))
            proc = rec.get("process")
            if proc is None or "sentrydemo" not in proc.attrib.get("fmt", ""):
                continue
            for k, v in rec.items():
                if k and "energy" in k:
                    total += _num(v) or 0
        return total
    return None


# Which recorders a cell runs: Sentry replay in T3/T4 and in the demo's own config (sentry, both,
# both-replay); ouo replay in ouo T3/T4, both-replay and ouo-replay.
def replay_expected(cell):
    sdk, _, tier = cell.partition("-T")
    if tier:
        return {sdk} if tier in ("3", "4") else set()
    return {"sentry": {"sentry"}, "both": {"sentry"}, "both-replay": {"sentry", "ouo"}, "ouo-replay": {"ouo"}}.get(cell, set())


def sdks_of(cell):
    if cell == "none":
        return set()
    if cell in ("both", "both-replay"):
        return {"sentry", "ouo"}
    return {"ouo"} if cell.startswith("ouo") else {"sentry"}


def replay_sent(requests, meta):
    t0, t1 = meta["host_t0"] - 1, meta["host_t1"] + 1
    got = set()
    for r in requests:
        if t0 <= r["t"] <= t1:
            if r["label"] == "replay" and 200 <= (r.get("status") or 0) < 300:
                got.add("ouo")
            if r["label"] == "sentry" and any(t == "replay_video" for t, _ in r.get("items", [])):
                got.add("sentry")
    return got


def hitches(d, seconds):
    """xctrace Hitches (device, bench.py --power): one hitches-summary row per hitch; the app is in front
    the whole run. Count, total ms, and hitch time ratio in ms per second (Apple's metric)."""
    p = os.path.join(d, "hitches-summary.xml")
    if not os.path.exists(p):
        return {}
    root = ET.parse(p).getroot()
    byid = {e.attrib["id"]: e for e in root.iter() if "id" in e.attrib}
    deref = lambda e: byid.get(e.attrib["ref"], e) if e is not None and "ref" in e.attrib else e
    cols = [c.findtext("mnemonic") for c in root.find(".//schema").findall("col")]
    durs = []
    for row in root.iter("row"):
        rec = dict(zip(cols, (deref(c) for c in row)))
        v = _num(rec.get("duration"))
        if v is not None:
            durs.append(v / 1e6)
    return {"hitches": len(durs), "hitch_ms": sum(durs), "hitch_ratio": sum(durs) / seconds if seconds else None}


def run_metrics(d, requests):
    meta = json.load(open(os.path.join(d, "meta.json")))
    m = {"kind": meta["kind"], "cell": meta["cell"], "round": meta["round"], "dir": d, "ok": True, "problems": []}
    perf = json.load(open(os.path.join(d, "perf.json"))) if os.path.exists(os.path.join(d, "perf.json")) else None
    smp = sim_samples(d) or device_samples(d)
    tl = launch_time(d)
    m.update(network(requests, meta))
    if meta["kind"] == "main" and not meta.get("offline"):
        # An SDK that sent nothing did not run (e.g. sentry-cocoa skipping its native start when
        # the build has a sentry.options.json): such a run would show that SDK as free.
        silent = sorted(sdk for sdk, label in (("sentry", "sentry"), ("ouo", "otlp"))
                        if sdk in sdks_of(meta["cell"]) and not m["net"].get(label, {}).get("req"))
        if silent:
            m["replay_missing"] = silent
            m["problems"].append(f"SDK sent nothing: {', '.join(silent)} (run excluded from the stats)")
        missing = replay_expected(meta["cell"]) - replay_sent(requests, meta)
        if missing and not silent:
            # A recorder that never uploaded costs less than one that runs: kept out of the cell's
            # statistics (it would flatter that SDK) and counted per cell instead.
            m["replay_missing"] = sorted(missing)  # excluded like a silent SDK
            m["problems"].append(f"replay expected but nothing uploaded: {', '.join(sorted(missing))} (run excluded from the stats)")
    m.update(disk(d))
    m.update(hitches(d, meta["seconds"]))
    if meta.get("energy"):
        m["energy_mj"] = energy(d)
    if perf is None or tl is None:
        m["ok"] = False
        m["problems"].append("no perf.json" if perf is None else "no launch time")
        return m
    js0 = perf["jsStartMs"] / 1000
    ff = perf["firstFrameMs"] / 1000 if perf.get("firstFrameMs") else None
    m["start_ms"] = (ff - js0) * 1000 if ff else None
    m["mode_recorded"] = perf.get("mode")
    m.update(frames(perf))
    steps = sum(1 for l in open(os.path.join(d, "steps.log")) if l.startswith("PERF step"))
    m["steps"] = steps
    if smp and smp["samples"]:
        s = smp["samples"]
        if smp["process_start"]:
            m["premain_s"] = js0 - smp["process_start"]
        end = min(tl + JOURNEY_END, s[-1]["t"])
        m["cpu_pct"] = cpu_pct(s, js0, end)
        m["wakeups"] = at(s, end, "wakeups") - at(s, js0, "wakeups")  # idle wakeups, JS start to journey end
        m["cpu_p95_pct"] = pctl([cpu_pct(s, x, x + 1) for x in range(int(js0) + 1, int(end))], 0.95)
        if s[-1]["t"] >= tl + IDLE[1] - 1:
            m["idle_cpu_pct"] = cpu_pct(s, tl + IDLE[0], min(tl + IDLE[1], s[-1]["t"]))
            tail = [x["footprint"] for x in s if tl + IDLE[0] <= x["t"] <= tl + IDLE[1]]
            m["steady_mb"] = statistics.median(tail) / 2**20 if tail else None
        m["peak_mb"] = smp["peak"] / 2**20 if smp["peak"] else None
        if meta["kind"] == "soak":
            warm = min(300, 0.2 * meta["seconds"])  # 5 min, or a fifth of a short (test) soak
            pts = [((x["t"] - tl) / 3600, x["footprint"] / 2**20) for x in s if x["t"] - tl >= warm]
            if len(pts) > 10:
                mx, my = statistics.mean(p[0] for p in pts), statistics.mean(p[1] for p in pts)
                m["growth_mb_h"] = sum((p[0] - mx) * (p[1] - my) for p in pts) / sum((p[0] - mx) ** 2 for p in pts)
                m["soak_start_mb"], m["soak_end_mb"] = pts[0][1], pts[-1][1]
            step = max(1, len(s) // 400)
            m["series"] = [[round(x["t"] - tl, 1), round(x["footprint"] / 2**20, 1)] for x in s[::step]]
        else:
            m["series"] = [[sec, round(cpu_pct(s, tl + sec - 1, tl + sec) or 0, 1), round(at(s, tl + sec, "footprint") / 2**20, 1)]
                           for sec in range(1, int(min(meta["seconds"], s[-1]["t"] - tl)) + 1)]
    else:
        m["problems"].append("no recorder samples")
    if meta["kind"] == "main" and steps < 19 and meta.get("journey", "taps") == "taps":
        # The journey stopped early (XCUITest lost the app: kAXErrorServerNotFound, seen once in
        # 27 device runs): it did less work than the others, so it is excluded like a silent SDK.
        m["replay_missing"] = m.get("replay_missing") or ["journey"]
        m["problems"].append(f"{steps}/19 steps (run excluded from the stats)")
    return m


def summarize(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    q = statistics.quantiles(v, n=4, method="inclusive") if len(v) >= 2 else [v[0], v[0], v[0]]
    return {"median": statistics.median(v), "q1": q[0], "q3": q[2], "min": v[0], "max": v[-1], "n": len(v)}


def paired(runs, a, b):
    ra = {r["round"]: r for r in runs if r["cell"] == a}
    rb = {r["round"]: r for r in runs if r["cell"] == b}
    common = sorted(set(ra) & set(rb))
    if not common:
        return None
    return {k: summarize([None if rb[c].get(k) is None or ra[c].get(k) is None else rb[c][k] - ra[c][k] for c in common]) for k in KEYS}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--size")
    ap.add_argument("--json")
    a = ap.parse_args()
    meta = json.load(open(os.path.join(a.out, "meta.json")))
    req_path = os.path.join(a.out, "requests.jsonl")
    requests = [json.loads(l) for l in open(req_path)] if os.path.exists(req_path) else []
    runs = []
    for d in sorted(glob.glob(os.path.join(a.out, "runs", "*", "*", "run*"))):
        if os.path.exists(os.path.join(d, "meta.json")):
            runs.append(run_metrics(d, requests))
    all_main = [r for r in runs if r["kind"] == "main"]
    main_runs = [r for r in all_main if not r.get("replay_missing")]
    # Tap check: the backend requests of every run should be the same multiset (each tap lands).
    sigs = {}
    for r in all_main:
        sigs.setdefault(tuple(r.get("backend_paths", [])), []).append(r)
    expected = max(sigs, key=lambda k: len(sigs[k])) if sigs else ()
    for sig, rs in sigs.items():
        if sig != expected:
            for r in rs:
                r["problems"].append("backend requests differ from the usual run (an extra or a missed request; listed, not excluded)")
    cells = {}
    for c in meta["cells"]:
        rs = [r for r in main_runs if r["cell"] == c]
        cells[c] = {k: summarize([r.get(k) for r in rs]) for k in KEYS}
        cells[c]["replay_missing_runs"] = sum(1 for r in all_main if r["cell"] == c and r.get("replay_missing"))
        cells[c]["runs_total"] = sum(1 for r in all_main if r["cell"] == c)
        cells[c]["refresh_hz"] = statistics.median([r["refresh_hz"] for r in rs if r.get("refresh_hz")] or [0]) or None
        labels = sorted({l for r in rs for l in r.get("net", {})})
        cells[c]["net"] = {l: {f: statistics.median([r["net"].get(l, {}).get(f, 0) for r in rs]) for f in ("req", "up", "up_decoded", "down")} for l in labels}
        if any(r.get("energy_mj") is not None for r in runs if r["cell"] == c and r["kind"] == "energy"):
            cells[c]["energy_mj"] = summarize([r.get("energy_mj") for r in runs if r["cell"] == c and r["kind"] == "energy"])
    vs_none = {c: paired(main_runs, "none", c) for c in meta["cells"] if c != "none"}
    tiers = {}
    for tier in ("T1", "T2", "T3", "T4"):
        s, o = f"sentry-{tier}", f"ouo-{tier}" if tier != "T1" else "ouo-T2"
        if s in meta["cells"] and o in meta["cells"]:
            tiers[tier] = {"sentry": s, "ouo": o, "ouo_minus_sentry": paired(main_runs, s, o), "ouo_note": "ouo has no T1: its T2" if tier == "T1" else None}
    extra = {}
    for r in runs:
        if r["kind"] in ("soak", "offline", "recover"):
            keep = {k: r.get(k) for k in ("growth_mb_h", "soak_start_mb", "soak_end_mb", "peak_mb", "steady_mb", "disk_sentry_kb",
                                          "disk_ouo_kb", "sdk_req", "sdk_up_kb", "net", "series", "disk_files", "problems")}
            extra.setdefault(r["kind"], {})[r["cell"]] = keep
    result = {"meta": meta, "cells": cells, "vs_none": vs_none, "tiers": tiers, **extra,
              "runs": [{k: v for k, v in r.items() if k not in ("series",)} | ({"series": r["series"]} if r["kind"] == "main" and r["round"] == 1 and "series" in r else {})
                       for r in runs],
              "problems": [f"{r['kind']}/{r['cell']}/run{r['round']}: {p}" for r in runs for p in r["problems"]]}
    if a.size and os.path.exists(a.size):
        result["size"] = json.load(open(a.size))
    hdr = f"{'cell':10} {'n':>2} {'start':>6} {'cpu%':>6} {'p95%':>6} {'idle%':>6} {'peakMB':>7} {'stdyMB':>7} {'req':>4} {'upKB':>7} {'decKB':>7} {'rplKB/m':>8} {'drop%':>6}"
    print(hdr)
    for c, g in cells.items():
        f = lambda k, p=1: f"{g[k]['median']:.{p}f}" if g.get(k) else "-"
        n = g["cpu_pct"]["n"] if g.get("cpu_pct") else 0
        print(f"{c:10} {n:>2} {f('start_ms',0):>6} {f('cpu_pct'):>6} {f('cpu_p95_pct'):>6} {f('idle_cpu_pct'):>6} {f('peak_mb'):>7} {f('steady_mb'):>7} "
              f"{f('sdk_req',0):>4} {f('sdk_up_kb',0):>7} {f('sdk_up_decoded_kb',0):>7} {f('replay_kb_min',0):>8} {f('dropped_pct',2):>6}")
    for p in result["problems"]:
        print("PROBLEM", p)
    if a.json:
        json.dump(result, open(a.json, "w"))


if __name__ == "__main__":
    main()
