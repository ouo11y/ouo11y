#!/usr/bin/env python3
"""Folds out/runs.jsonl, out/capture.jsonl and out/sizes.json into ../results.json."""
import json, os, statistics as st
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
runs = [json.loads(l) for l in open(f"{root}/out/runs.jsonl") if l.strip()]
cap = [json.loads(l) for l in open(f"{root}/out/capture.jsonl") if l.strip()]
sizes = json.load(open(f"{root}/out/sizes.json"))
load = [json.loads(l) for l in open(f"{root}/out/load.jsonl") if l.strip()] if os.path.exists(f"{root}/out/load.jsonl") else []
def run_load(r):  # Mac load averages (vm.loadavg, same numbers as `uptime`) sampled every 10 s during the run
    xs = [x for x in load if r["t_launch"] - 5 <= x["t"] <= r["t_end"] + 5]
    return {"load1_mean": round(st.mean(x["load1"] for x in xs), 1), "load1_max": max(x["load1"] for x in xs), "samples": len(xs)} if xs else None
meta = json.load(open(f"{root}/out/meta.json"))
TICK_MS = 10  # CLK_TCK = 100 on the emulator kernel

def p90(xs):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(round(0.9 * (len(xs) - 1))))]
def summ(xs, nd=1):
    xs = [x for x in xs if x is not None]
    if not xs: return None
    return {"median": round(st.median(xs), nd), "p90": round(p90(xs), nd), "min": round(min(xs), nd), "max": round(max(xs), nd), "n": len(xs)}

def own(r, c):  # a stalled emulator can deliver a previous Sentry run's envelope late: count only this SDK's paths
    if c["port"] != 8712: return True
    if r["variant"].startswith("sentry"): return c["path"].startswith("/api/1/")
    if r["variant"] == "ouofull": return c["path"].startswith("/v1/replay/")
    return False

def wire(r, t0, t1, port=8712):
    rs = [c for c in cap if c["port"] == port and t0 <= c["t"] < t1 and own(r, c)]
    return rs

variants = {}
order = ["baseline", "ouosignals", "ouofull", "sentrycore", "sentryreplay", "sentryfull"]
for v in order:
    rr = [r for r in runs if r["variant"] == v]
    out = {}
    s = sizes.get(v)
    if s:
        out.update({"size_bytes": s["delta_uncompressed_bytes"], "size_zipped_bytes": s["delta_apk_bytes"],
                    "size_dex_bytes": s["delta_dex_bytes"], "size_native_bytes": s["native_bytes"], "apk_bytes_absolute": s["apk_bytes"]})
    if rr:
        jmin = [(r["t_j1"] - r["t_j0"]) / 60 for r in rr]
        cpu_j = [r["cpu_ticks"]["journey"] * TICK_MS / m for r, m in zip(rr, jmin)]
        cpu_i = [r["cpu_ticks"]["idle"] * TICK_MS / ((r["t_j0"] - r["t_idle0"]) / 60) for r in rr]
        jw = [wire(r, r["t_j0"], r["t_end"]) for r in rr]
        sw = [wire(r, r["t_launch"], r["t_j0"]) for r in rr]
        api = [wire(r, r["t_launch"], r["t_end"], 8711) for r in rr]
        out.update({
            "init_ms": summ([r["init_ns"] / 1e6 for r in rr if r["init_ns"] is not None], 2),
            "cold_start_ms": summ([r["start_total_ms"] for r in rr], 0),
            "cpu_ms_per_min": {"journey": summ(cpu_j, 0), "idle_static_screen": summ(cpu_i, 0)},
            "mem_mb": {"idle": round(st.median(r["mem_idle"]["pss_kb"] for r in rr) / 1024, 1),
                       "peak": round(st.median(max(m["pss_kb"] for m in r["mem_samples"]) for r in rr) / 1024, 1),
                       "peak_rss_hwm": round(st.median(r["vm_hwm_kb"] for r in rr) / 1024, 1),
                       "idle_spread": summ([r["mem_idle"]["pss_kb"] / 1024 for r in rr]),
                       "peak_spread": summ([max(m["pss_kb"] for m in r["mem_samples"]) / 1024 for r in rr])},
            "wire_bytes_per_min": summ([sum(c["body"] + c["hdr"] for c in w) / m for w, m in zip(jw, jmin)], 0),
            "wire_body_bytes_per_min": summ([sum(c["body"] for c in w) / m for w, m in zip(jw, jmin)], 0),
            "requests_per_min": round(st.median(len(w) / m for w, m in zip(jw, jmin)), 1),
            "startup_and_idle_wire_bytes": summ([sum(c["body"] + c["hdr"] for c in w) for w in sw], 0),
            "telemetry_paths": sorted({c["path"] for w in jw + sw for c in w}),
            "app_api_header_bytes_per_request": round(st.median(st.mean(c["hdr"] for c in a) for a in api if a), 0),
            "journey_cpu_ms_by_thread": {k: round(st.median(r["journey_threads"].get(k, 0) * TICK_MS for r in rr))
                                         for k in sorted({k for r in rr for k in r["journey_threads"]}) if st.median(r["journey_threads"].get(k, 0) for r in rr) >= 2},
            "host_load_per_run": [{"run": r["run"], "load_at_start_1_5_15": r.get("host_load_at_start"), **(run_load(r) or {"load1_mean": None, "note": "load sampler started after this run"})} for r in rr],
            "host_load1_median": (lambda xs: round(st.median(xs), 1) if xs else None)([run_load(r)["load1_mean"] for r in rr if run_load(r)]),
            "runs_refocused": sum(1 for r in rr if r.get("refocused")),
            "process_died_during_run": sum(not r["alive"] for r in rr),
        })
    variants[v] = out

b = variants["baseline"]
for v, o in variants.items():
    if v == "baseline" or "cpu_ms_per_min" not in o: continue
    o["delta_vs_baseline"] = {
        "init_ms": round(o["init_ms"]["median"] - b["init_ms"]["median"], 2),
        "cold_start_ms": o["cold_start_ms"]["median"] - b["cold_start_ms"]["median"],
        "cpu_ms_per_min_journey": o["cpu_ms_per_min"]["journey"]["median"] - b["cpu_ms_per_min"]["journey"]["median"],
        "cpu_ms_per_min_idle": o["cpu_ms_per_min"]["idle_static_screen"]["median"] - b["cpu_ms_per_min"]["idle_static_screen"]["median"],
        "mem_mb_idle": round(o["mem_mb"]["idle"] - b["mem_mb"]["idle"], 1),
        "mem_mb_peak": round(o["mem_mb"]["peak"] - b["mem_mb"]["peak"], 1),
        "app_api_header_bytes_per_request": o["app_api_header_bytes_per_request"] - b["app_api_header_bytes_per_request"],
    }

res = {"platform": "android", **meta, "variants": variants}
res["invalid_runs_rerun"] = [{"variant": r["variant"], "run": r["run"], "journey_cpu_ticks": r["cpu_ticks"]["journey"]}
                             for r in (json.loads(l) for l in open(f"{root}/out/runs_invalid.jsonl") if l.strip())]
res["not_measured"] = json.load(open(f"{root}/out/not_measured.json"))
res["method"] = open(f"{root}/out/method.txt").read().strip()
json.dump(res, open(f"{root}/results.json", "w"), indent=1)
for v, o in variants.items():
    if "cpu_ms_per_min" in o:
        print(f"{v:13} init {o['init_ms']['median']:>7} start {o['cold_start_ms']['median']:>5} cpuJ {o['cpu_ms_per_min']['journey']['median']:>6} cpuI {o['cpu_ms_per_min']['idle_static_screen']['median']:>4} "
              f"pss {o['mem_mb']['idle']}/{o['mem_mb']['peak']} wire {o['wire_bytes_per_min']['median']:>8} req {o['requests_per_min']} n={o['init_ms']['n']}")
