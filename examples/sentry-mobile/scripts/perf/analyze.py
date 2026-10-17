#!/usr/bin/env python3
"""Per-run metrics and per-mode medians from scripts/perf/run.sh output.

    python3 -I analyze.py --runs <out dir> --requests <proxy requests.jsonl> [--json summary.json]

Per run (times from the kernel's process start time, `st`):
  start_ms        JS start (first module evaluated) -> first frame of the first screen. Both SDKs
                  initialise in this span. Process start -> JS start is reported apart: on the
                  simulator it is 2-5 s of dyld_sim work at ~100 % CPU that is the same for every mode.
  cpu_s           app CPU time (user + system) from JS start to st + window; cpu_pct = cpu_s / wall.
  idle_cpu_pct    CPU % in the idle tail (st + 80 s .. st + window), when no tap happens: the cost of
                  whatever the SDKs keep doing on their own (replay capture, flush timers).
  peak_mb         lifetime peak phys_footprint; steady_mb median phys_footprint in the idle tail.
  req, sent_kb, recv_kb   HTTP requests and bytes through the proxy, by destination.
  dropped         JS frames missed: sum over rAF intervals of round(interval / 16.67 ms) - 1.
  long_frames     rAF intervals > 50 ms (3+ frames missed at once).
"""
import argparse
import glob
import json
import os
import statistics

FRAME_MS = 1000 / 60
IDLE_FROM = 80.0


def at(samples, t, key):
    """Linear interpolation of a cumulative counter at time t (seconds after process start)."""
    prev = samples[0]
    for s in samples:
        if s["t"] >= t:
            if s is prev or s["t"] == prev["t"]:
                return s[key]
            f = (t - prev["t"]) / (s["t"] - prev["t"])
            return prev[key] + f * (s[key] - prev[key])
        prev = s
    return samples[-1][key]


def run_metrics(d, requests, window):
    smp = json.load(open(os.path.join(d, "samples.json")))
    perf = json.load(open(os.path.join(d, "perf.json")))
    st = smp["process_start"]
    s = smp["samples"]
    js0 = perf["jsStartMs"] / 1000 - st
    ff = perf["firstFrameMs"] / 1000 - st if perf.get("firstFrameMs") else None
    end = min(window, s[-1]["t"])
    cpu_s = (at(s, end, "cpu_ns") - at(s, js0, "cpu_ns")) / 1e9
    idle_cpu = (at(s, end, "cpu_ns") - at(s, IDLE_FROM, "cpu_ns")) / 1e9
    energy_j = (at(s, end, "energy_nj") - at(s, js0, "energy_nj")) / 1e9
    tail = [x["footprint"] for x in s if x["t"] >= IDLE_FROM]
    m = {
        "premain_s": js0,
        "start_ms": (ff - js0) * 1000 if ff is not None else None,
        "launch_to_frame_ms": ff * 1000 if ff is not None else None,
        "cpu_s": cpu_s,
        "cpu_pct": 100 * cpu_s / (end - js0),
        "idle_cpu_pct": 100 * idle_cpu / (end - IDLE_FROM),
        "energy_j": energy_j,
        "peak_mb": s[-1]["lifetime_max_footprint"] / 2**20,
        "steady_mb": statistics.median(tail) / 2**20 if tail else None,
        "wakeups": s[-1]["wakeups"] - (s[0]["wakeups"] if s else 0),
    }
    # network: requests the app started inside the window
    by = {}
    for r in requests:
        if st - 0.5 <= r["t"] <= st + window:
            b = by.setdefault(r["label"], {"req": 0, "sent": 0, "recv": 0})
            b["req"] += 1
            b["sent"] += r["req_bytes"]
            b["recv"] += r["resp_bytes"]
    m["net"] = by
    m["req"] = sum(b["req"] for b in by.values())
    m["sent_kb"] = sum(b["sent"] for b in by.values()) / 1024
    m["recv_kb"] = sum(b["recv"] for b in by.values()) / 1024
    sdk = {k: v for k, v in by.items() if k != "backend"}
    m["sdk_req"] = sum(b["req"] for b in sdk.values())
    m["sdk_sent_kb"] = sum(b["sent"] for b in sdk.values()) / 1024
    # JS frames
    hist = {int(k): v for k, v in perf["hist"].items()}
    frames = sum(hist.values())
    dropped = sum(v * max(0, round(k / FRAME_MS) - 1) for k, v in hist.items())
    m["frames"] = frames
    m["dropped"] = dropped
    m["dropped_pct"] = 100 * dropped / (frames + dropped) if frames else None
    m["long_frames"] = sum(v for k, v in hist.items() if k > 50)
    m["max_frame_ms"] = perf["maxDt"]
    # series for charts: CPU % per second and footprint MB, t from process start
    series = []
    for sec in range(int(js0) + 1, int(end) + 1):
        c = (at(s, sec, "cpu_ns") - at(s, sec - 1, "cpu_ns")) / 1e9 * 100
        fp = at(s, sec, "footprint") / 2**20
        series.append([sec, round(c, 1), round(fp, 1)])
    m["series"] = series
    m["read_failures"] = smp.get("read_failures", 0)
    return m


KEYS = ["start_ms", "cpu_s", "cpu_pct", "idle_cpu_pct", "energy_j", "peak_mb", "steady_mb", "req", "sent_kb",
        "recv_kb", "sdk_req", "sdk_sent_kb", "dropped", "dropped_pct", "long_frames", "max_frame_ms", "premain_s"]


def summarize(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    q = statistics.quantiles(v, n=4) if len(v) >= 2 else [v[0], v[0], v[0]]
    return {"median": statistics.median(v), "min": v[0], "max": v[-1], "q1": q[0], "q3": q[2], "n": len(v), "values": v}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--requests", required=True)
    ap.add_argument("--window", type=float, default=95)
    ap.add_argument("--json")
    a = ap.parse_args()
    requests = [json.loads(l) for l in open(a.requests)]
    out = {"modes": {}, "runs": []}
    for d in sorted(glob.glob(os.path.join(a.runs, "*", "run*"))):
        if not os.path.exists(os.path.join(d, "perf.json")):
            continue
        mode = os.path.basename(os.path.dirname(d))
        m = run_metrics(d, requests, a.window)
        m["mode"], m["run"] = mode, os.path.basename(d)
        out["runs"].append(m)
    for mode in sorted({r["mode"] for r in out["runs"]}):
        rs = [r for r in out["runs"] if r["mode"] == mode]
        agg = {k: summarize([r[k] for r in rs]) for k in KEYS}
        labels = sorted({l for r in rs for l in r["net"]})
        agg["net"] = {l: {f: statistics.median([r["net"].get(l, {}).get(f, 0) for r in rs]) for f in ("req", "sent", "recv")} for l in labels}
        out["modes"][mode] = agg
    # Paired deltas: mode B minus mode A in the same round (runs are interleaved per round), which
    # cancels drift on the host between rounds.
    pairs = [("sentry", "both"), ("sentry", "both-replay"), ("both", "both-replay"), ("none", "sentry"), ("none", "ouo-replay")]
    out["paired"] = {}
    for ma, mb in pairs:
        ra = {r["run"]: r for r in out["runs"] if r["mode"] == ma}
        rb = {r["run"]: r for r in out["runs"] if r["mode"] == mb}
        common = sorted(set(ra) & set(rb))
        if common:
            out["paired"][f"{mb}-{ma}"] = {k: summarize([None if rb[c][k] is None or ra[c][k] is None else rb[c][k] - ra[c][k] for c in common]) for k in KEYS}
    for name, g in out["paired"].items():
        print(f"paired {name:22} " + " ".join(f"{k} {g[k]['median']:+.1f} [{g[k]['min']:+.1f},{g[k]['max']:+.1f}]" for k in ("cpu_pct", "idle_cpu_pct", "steady_mb", "peak_mb", "start_ms", "dropped") if g[k]))
    print(f"{'mode':12} {'n':>2} {'start ms':>9} {'cpu %':>6} {'idle %':>6} {'peak MB':>8} {'steady MB':>9} {'req':>5} {'sdk KB up':>9} {'dropped':>7} {'long':>5}")
    for mode, g in out["modes"].items():
        f = lambda k, p=0: f"{g[k]['median']:.{p}f}" if g[k] else "-"
        print(f"{mode:12} {g['cpu_s']['n']:>2} {f('start_ms'):>9} {f('cpu_pct',1):>6} {f('idle_cpu_pct',1):>6} {f('peak_mb',1):>8} {f('steady_mb',1):>9} {f('req'):>5} {f('sdk_sent_kb'):>9} {f('dropped'):>7} {f('long_frames'):>5}")
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(out, fh)


if __name__ == "__main__":
    main()
