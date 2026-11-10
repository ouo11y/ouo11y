#!/usr/bin/env python3
"""Turns a run folder into results.json.
    python3 -I analyze.py <out dir> <build/sizes.json> <meta.json> > results.json
Windows (seconds from process start): idle 5-20 (CPU) / 10-20 (memory), journey 20-80,
peak memory 0-85 (foreground). Wire: every SDK request (not the app's own backend calls)
between launch and the end of the run (85 s foreground + 15 s background), scaled to one minute."""
import glob, json, os, statistics, sys

out, sizes_p, meta_p = sys.argv[1:4]
sizes = json.load(open(sizes_p))
meta = json.load(open(meta_p))
VARIANTS = ["base", "ouo", "ouo_replay", "sentry", "sentry_replay"]
APP = {"base": "base", "ouo": "ouo", "ouo_replay": "ouo", "sentry": "sentry", "sentry_replay": "sentry"}


def q(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def stats(xs, nd=2):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    r = lambda v: round(v, nd)
    return {"median": r(statistics.median(xs)), "p90": r(q(xs, 0.9)), "q1": r(q(xs, 0.25)), "q3": r(q(xs, 0.75)),
            "min": r(min(xs)), "max": r(max(xs)), "n": len(xs)}


def at(samples, t):
    best = min(samples, key=lambda s: abs(s["t"] - t))
    return best


loads = []
if os.path.exists(os.path.join(out, "load.log")):
    for l in open(os.path.join(out, "load.log")):
        p = l.split()
        if len(p) >= 2:
            loads.append((float(p[0]), float(p[1])))


def load_in(a, b):
    """Mean host 1-min load average sampled in [a, b] (vm.loadavg every 5 s), None if not logged."""
    xs = [v for t, v in loads if a - 2.5 <= t <= b + 2.5]
    return round(sum(xs) / len(xs), 1) if xs else None


marks = {}
if os.path.exists(os.path.join(out, "marks.log")):
    for l in open(os.path.join(out, "marks.log")):
        p = l.split()  # <time> start init <variant> <round>
        marks[(p[3], p[4])] = float(p[0])

reqs = [json.loads(l) for l in open(os.path.join(out, "requests.jsonl"))]
runs = [json.loads(l) for l in open(os.path.join(out, "runs.jsonl"))]
res = {}
excluded = []
for v in VARIANTS:
    inits, init_runs = [], []
    for f in sorted(glob.glob(os.path.join(out, "init", f"{v}-*.jsonl"))):
        rnd = os.path.basename(f)[len(v) + 1:-len(".jsonl")]
        t = marks.get((v, rnd))
        ld = load_in(t, t + 6) if t else None
        for l in open(f):
            o = json.loads(l)
            if o.get("kind") == "init" and o.get("sdk"):
                inits.append(o["initMs"])
                init_runs.append({"round": rnd, "init_ms": round(o["initMs"], 3), "load1": ld})
    cpu_idle, cpu_j, mem_idle, mem_j, mem_peak = [], [], [], [], []
    wire, wire_hdr, nreq, wire_replay, decoded = [], [], [], [], []
    per_label = {}
    journey_runs = []
    for run in [r for r in runs if r["variant"] == v]:
        sj = os.path.join(out, "journey", f"{v}-{run['round']}.json")
        s = json.load(open(sj))["samples"]
        notes = [json.loads(l) for l in open(os.path.join(out, "journey", f"{v}-{run['round']}.jsonl"))]
        if not any(n.get("kind") == "journey-end" for n in notes) or s[-1]["t"] < 84:
            excluded.append({"variant": v, "round": run["round"], "why": "journey did not finish or sampler ended early"})
            continue
        window = [r for r in reqs if run["t0"] <= r["t"] <= run["t1"] and r["label"] != "backend"]
        if v != "base" and not window:
            excluded.append({"variant": v, "round": run["round"], "why": "SDK sent no request"})
            continue
        if v.endswith("_replay") and not any(r["label"] == "ouo-replay" or "replay_video" in (r.get("items") or []) for r in window):
            excluded.append({"variant": v, "round": run["round"], "why": "replay variant uploaded no replay"})
            continue
        cpu_idle.append((at(s, 20)["cpu_ns"] - at(s, 5)["cpu_ns"]) / 1e6 * 60 / (at(s, 20)["t"] - at(s, 5)["t"]))
        cpu_j.append((at(s, 80)["cpu_ns"] - at(s, 20)["cpu_ns"]) / 1e6 * 60 / (at(s, 80)["t"] - at(s, 20)["t"]))
        mem_idle.append(statistics.median(x["footprint"] for x in s if 10 <= x["t"] <= 20) / 2**20)
        mem_j.append(statistics.median(x["footprint"] for x in s if 20 <= x["t"] <= 80) / 2**20)
        mem_peak.append(max(x["footprint"] for x in s if x["t"] <= 85) / 2**20)
        mins = (run["t1"] - run["t0"]) / 60
        wire.append(sum(r["body_bytes"] for r in window) / mins)
        wire_hdr.append(sum(r["body_bytes"] + r["header_bytes"] for r in window) / mins)
        decoded.append(sum(r["decoded_bytes"] or r["body_bytes"] for r in window) / mins)
        wire_replay.append(sum(r["body_bytes"] for r in window if r["label"] == "ouo-replay" or any(i and i.startswith("replay") for i in (r.get("items") or []))) / mins)
        nreq.append(len(window) / mins)
        journey_runs.append({"round": run["round"], "load1": load_in(run["t0"], run["t1"]),
                             "cpu_idle_ms_per_min": round(cpu_idle[-1]), "cpu_journey_ms_per_min": round(cpu_j[-1]),
                             "mem_idle_mb": round(mem_idle[-1], 1), "mem_peak_mb": round(mem_peak[-1], 1),
                             "wire_bytes_per_min": round(wire[-1]), "requests_per_min": round(nreq[-1], 1)})
        for r in window:
            key = r["label"] + " " + r["path"].split("?")[0]
            d = per_label.setdefault(key, [0, 0])
            d[0] += 1
            d[1] += r["body_bytes"]
    sz = sizes[APP[v]]
    res[v] = {
        "size_bytes": sz["dev"]["app_bytes"], "size_zipped_bytes": sz["dev"]["zipped_bytes"],
        "size_delta_bytes": sz["dev"].get("delta_app_bytes"), "size_zipped_delta_bytes": sz["dev"].get("delta_zipped_bytes"),
        "size_sim_arm64_bytes": sz["sim"]["app_bytes"], "size_sim_delta_bytes": sz["sim"].get("delta_app_bytes"),
        "init_ms": stats(inits, 3) if inits else None,
        "cpu_ms_per_min": {"idle": stats(cpu_idle, 0), "journey": stats(cpu_j, 0)},
        "mem_mb": {"idle": stats(mem_idle, 1), "journey": stats(mem_j, 1), "peak": stats(mem_peak, 1)},
        "wire_bytes_per_min": {"body_as_sent": stats(wire, 0), "body_plus_headers": stats(wire_hdr, 0),
                               "decoded_body": stats(decoded, 0), "replay_part": stats(wire_replay, 0)},
        "requests_per_min": stats(nreq, 1),
        "host_load1": {"init": stats([r["load1"] for r in init_runs], 1), "journey": stats([r["load1"] for r in journey_runs], 1)},
        "runs": {"init": init_runs, "journey": journey_runs},
        "endpoints_all_runs": {k: {"requests": c, "body_bytes": b} for k, (c, b) in sorted(per_label.items())},
    }
base = res["base"]
for v in VARIANTS:
    d = {}
    for k in ("idle", "journey"):
        if res[v]["cpu_ms_per_min"][k] and base["cpu_ms_per_min"][k]:
            d["cpu_" + k + "_ms_per_min"] = round(res[v]["cpu_ms_per_min"][k]["median"] - base["cpu_ms_per_min"][k]["median"])
    for k in ("idle", "journey", "peak"):
        if res[v]["mem_mb"][k] and base["mem_mb"][k]:
            d["mem_" + k + "_mb"] = round(res[v]["mem_mb"][k]["median"] - base["mem_mb"][k]["median"], 1)
    res[v]["delta_vs_base_median"] = d
meta["variants"] = res
meta["excluded_runs"] = excluded
print(json.dumps(meta, indent=1))
