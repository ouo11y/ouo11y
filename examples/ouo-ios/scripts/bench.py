#!/usr/bin/env python3
"""Paired median deltas of the native B3 cells (bench.sh): per round, `ouo` minus `none`.

    python3 -I bench.py <out dir> <rounds>

Per run: CPU over the 40 s (percent of one core), steady memory (median phys_footprint of the last
10 s, MB), peak memory (lifetime max footprint, MB), app start (process start to Home's first
viewDidAppear, ms), and for `ouo` the main-thread cost of `Ouo.start` (ms). Writes results.json.
"""
import json
import os
import statistics
import sys


def load(out, cell, r):
    s = json.load(open(os.path.join(out, f"{cell}-{r}.json")))
    notes = [json.loads(line) for line in open(os.path.join(out, f"{cell}-{r}.notes.jsonl"))]
    xs = s["samples"]
    if len(xs) < 2:
        return None
    first, last = xs[0], xs[-1]
    cpu = (last["cpu_ns"] - first["cpu_ns"]) / ((last["t"] - first["t"]) * 1e9) * 100
    tail = [x["footprint"] for x in xs if x["t"] >= last["t"] - 10]
    home = next((n["ts"] for n in notes if n["kind"] == "home"), None)
    launch = next((n for n in notes if n["kind"] == "launch"), {})
    return {
        "cpu_pct": cpu,
        "steady_mb": statistics.median(tail) / 1e6,
        "peak_mb": last["lifetime_max_footprint"] / 1e6,
        "app_start_ms": home - s["process_start"] * 1000 if home else None,
        "ouo_start_ms": launch.get("startMs"),
    }


def main():
    out, rounds = sys.argv[1], int(sys.argv[2])
    runs = {c: [load(out, c, r) for r in range(1, rounds + 1)] for c in ("none", "ouo")}
    result = {"rounds": rounds, "metrics": {}}
    for m in ("cpu_pct", "steady_mb", "peak_mb", "app_start_ms"):
        pairs = [(o[m], n[m]) for o, n in zip(runs["ouo"], runs["none"]) if o and n and o[m] is not None and n[m] is not None]
        deltas = sorted(o - n for o, n in pairs)
        q = statistics.quantiles(deltas, n=4) if len(deltas) >= 4 else [None, None, None]
        result["metrics"][m] = {
            "none_median": statistics.median(n for _, n in pairs),
            "ouo_median": statistics.median(o for o, _ in pairs),
            "delta_median": statistics.median(deltas),
            "delta_iqr": [q[0], q[2]],
            "pairs": len(pairs),
        }
    starts = [o["ouo_start_ms"] for o in runs["ouo"] if o and o["ouo_start_ms"] is not None]
    result["metrics"]["ouo_start_main_thread_ms"] = {"median": statistics.median(starts), "max": max(starts), "runs": len(starts)}
    json.dump(result, open(os.path.join(out, "results.json"), "w"), indent=2)
    for k, v in result["metrics"].items():
        print(k, {a: (round(b, 2) if isinstance(b, float) else b) for a, b in v.items() if a != "delta_iqr"}, "IQR", [round(x, 2) if x is not None else None for x in v.get("delta_iqr", [])])


if __name__ == "__main__":
    main()
