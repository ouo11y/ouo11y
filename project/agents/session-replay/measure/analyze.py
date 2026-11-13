#!/usr/bin/env python3
"""Summarises run.sh output after frames.swift ran on every run directory.
    python3 -I analyze.py <runs dir> > results.json
Per run: replay bytes as sent (gzip bodies) and decoded, requests, frames, bytes per minute over
the foreground window (launch to background, run.json t0..t1; the chunk cut on background is
included), main-thread capture stats from journey.jsonl, and the frames whose OCR found text.
Per recorder: median, min and max over the runs."""
import json, os, statistics, sys

root = sys.argv[1]
runs = []
for name in sorted(os.listdir(root)):
    d = os.path.join(root, name)
    if not os.path.isfile(os.path.join(d, "run.json")):
        continue
    meta = json.load(open(os.path.join(d, "run.json")))
    reqs = [json.loads(l) for l in open(os.path.join(d, "requests.jsonl"))] if os.path.exists(os.path.join(d, "requests.jsonl")) else []
    rp = [r for r in reqs if r["port"] == "replay"]
    window = meta["t1"] - meta["t0"]
    stats = {}
    for l in open(os.path.join(d, "journey.jsonl")):
        o = json.loads(l)
        if o.get("kind") == "replaydemo-done":
            stats = o["captureStats"]
    ocr = json.load(open(os.path.join(d, "ocr.json"))) if os.path.exists(os.path.join(d, "ocr.json")) else []
    texty = [{"file": f["file"], "text": [t["text"] for t in f["text"]]} for f in ocr if f["text"]]
    load = open(os.path.join(d, "load.txt")).read().split("load averages:")[-1].split()[0]
    runs.append({
        "run": name, "variant": meta["variant"], "round": meta["round"], "load1": float(load),
        "window_s": round(window, 1), "requests": len(rp),
        "bytes_sent": sum(r["body_bytes"] for r in rp), "bytes_decoded": sum(r["decoded_bytes"] for r in rp),
        "kib_per_min": round(sum(r["body_bytes"] for r in rp) / 1024 / (window / 60), 1),
        "frames": len(ocr), "captures": stats.get("count"), "main_ms_mean": stats.get("meanMs"),
        "main_ms_p50": stats.get("p50Ms"), "main_ms_p90": stats.get("p90Ms"), "main_ms_max": stats.get("maxMs"),
        "main_ms_total": stats.get("totalMs"), "frames_with_text": texty,
    })

summary = {}
for v in sorted({r["variant"] for r in runs}):
    rs = [r for r in runs if r["variant"] == v]
    s = {"n": len(rs)}
    for k in ["kib_per_min", "bytes_sent", "requests", "frames", "captures", "main_ms_mean", "main_ms_p50", "main_ms_p90", "main_ms_max", "main_ms_total"]:
        xs = [r[k] for r in rs if r[k] is not None]
        if xs:
            s[k] = {"median": round(statistics.median(xs), 2), "min": round(min(xs), 2), "max": round(max(xs), 2)}
    s["runs_with_text_frames"] = sum(1 for r in rs if r["frames_with_text"])
    summary[v] = s
json.dump({"summary": summary, "runs": runs}, sys.stdout, indent=1)
