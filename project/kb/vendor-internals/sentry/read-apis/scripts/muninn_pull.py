#!/usr/bin/env python3
"""Pull replays out of Sentry the way Muninn would, and check that nothing is missing.

1. Lists every replay in the window (follows the Link header cursors).
2. For each chosen replay: fetches details, downloads all segments twice
   (paged list endpoint and per-segment `?download`), and for mobile replays the mp4 of every segment.
3. Checks completeness and reassembles one time-ordered rrweb event array.

Stdlib only, read-only. Usage:
  SENTRY_URL=http://localhost:9000 SENTRY_TOKEN=<token with org:read project:read event:read> \
  python3 -I muninn_pull.py --org sentry --stats-period 30d [--replay <id> ...] [--out DIR] [--per-page 100]

Without --replay it picks the newest web replay and the newest mobile replay.
"""
import argparse, json, os, re, time, urllib.parse, urllib.request, urllib.error

URL = os.environ.get("SENTRY_URL", "http://localhost:9000").rstrip("/")
TOKEN = os.environ["SENTRY_TOKEN"]
LINK_RE = re.compile(r'<([^>]+)>;\s*rel="(\w+)";\s*results="(\w+)";\s*cursor="([^"]+)"')
STATS = {"requests": 0, "bytes": 0, "seconds": 0.0}


def http(path, headers=None, raw=False):
    url = path if path.startswith("http") else URL + path
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOKEN, **(headers or {})})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            status, hdrs = r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        body, status, hdrs = e.read(), e.code, dict(e.headers)
    dt = time.time() - t
    STATS["requests"] += 1; STATS["bytes"] += len(body); STATS["seconds"] += dt
    return status, hdrs, (body if raw else (json.loads(body) if body else None)), dt


def next_cursor(hdrs):
    """Return the next cursor if the Link header says there are more results."""
    for _url, rel, results, cursor in LINK_RE.findall(hdrs.get("Link") or hdrs.get("link") or ""):
        if rel == "next" and results == "true":
            return cursor
    return None


def list_replays(org, period, per_page, extra=""):
    out, cursor, pages = [], None, 0
    while True:
        q = f"/api/0/organizations/{org}/replays/?statsPeriod={period}&project=-1&per_page={per_page}&sort=-started_at{extra}"
        if cursor:
            q += "&cursor=" + urllib.parse.quote(cursor)
        status, hdrs, body, _ = http(q)
        if status != 200:
            raise SystemExit(f"list replays: HTTP {status} {body}")
        pages += 1
        out += body["data"]
        cursor = next_cursor(hdrs)
        if not cursor:
            return out, pages


def project_slug(org, project_id, cache={}):
    if not cache:
        _, _, body, _ = http(f"/api/0/organizations/{org}/projects/?all_projects=1")
        cache.update({p["id"]: p["slug"] for p in body})
    return cache[str(project_id)]


def pull_replay(org, replay_id, per_page, out_dir):
    s, _, details, _ = http(f"/api/0/organizations/{org}/replays/{replay_id}/")
    d = details["data"]
    slug = project_slug(org, d["project_id"])
    base = f"/api/0/projects/{org}/{slug}/replays/{replay_id}"
    n = d["count_segments"]
    rep = {"replay_id": replay_id, "project": slug, "platform": d["platform"], "sdk": d["sdk"],
           "duration_s": d["duration"], "count_segments": n, "started_at": d["started_at"], "finished_at": d["finished_at"]}

    # A. Paged list endpoint: body is [[seg0 events], [seg1 events], ...] in segment_id order.
    t = time.time(); listed, cursor, pages, list_bytes = [], None, 0, 0
    while True:
        q = f"{base}/recording-segments/?per_page={per_page}" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        st, hdrs, raw, _ = http(q, raw=True)
        pages += 1; list_bytes += len(raw)
        listed += json.loads(raw)
        cursor = next_cursor(hdrs)
        if not cursor:
            break
    rep["list_endpoint"] = {"pages": pages, "segments": len(listed), "bytes": list_bytes,
                            "seconds": round(time.time() - t, 3), "empty_segments": sum(1 for x in listed if x == [])}

    # B. Per-segment metadata + download: proves which segment ids exist (the list body has no ids).
    t = time.time(); per_seg, missing, seg_bytes, date_added = [], [], 0, []
    for i in range(n):
        st, _, meta, _ = http(f"{base}/recording-segments/{i}/")
        if st != 200:
            missing.append(i); per_seg.append(None); continue
        date_added.append(meta["data"]["dateAdded"])
        st, hdrs, raw, _ = http(f"{base}/recording-segments/{i}/?download", raw=True)
        seg_bytes += len(raw)
        per_seg.append(json.loads(raw))
    rep["per_segment_endpoint"] = {"requests": 2 * n, "bytes": seg_bytes, "seconds": round(time.time() - t, 3),
                                   "missing_segment_ids": missing,
                                   "first_date_added": min(date_added) if date_added else None,
                                   "last_date_added": max(date_added) if date_added else None}
    rep["list_matches_per_segment"] = [x for x in per_seg if x is not None] == listed

    # C. Mobile: one mp4 per segment, announced by a custom rrweb event with tag "video".
    videos = []
    for i, seg in enumerate(per_seg):
        for ev in seg or []:
            if ev.get("type") == 5 and ev.get("data", {}).get("tag") == "video":
                videos.append((i, ev["data"]["payload"]))
    if videos:
        t = time.time(); vbytes, bad = 0, []
        for i, payload in videos:
            st, hdrs, raw, _ = http(f"{base}/videos/{i}/", raw=True)
            vbytes += len(raw)
            if st != 200 or len(raw) != payload.get("size") or raw[4:8] != b"ftyp":
                bad.append({"segment": i, "status": st, "got": len(raw), "announced": payload.get("size")})
            if out_dir:
                os.makedirs(f"{out_dir}/{replay_id}", exist_ok=True)
                open(f"{out_dir}/{replay_id}/{i}.mp4", "wb").write(raw)
        rep["videos"] = {"count": len(videos), "bytes": vbytes, "seconds": round(time.time() - t, 3),
                         "size_or_magic_mismatch": bad,
                         "total_video_ms": sum(p.get("duration", 0) for _, p in videos)}

    # D. Reassemble: concatenate segments and sort by timestamp. rrweb core events use ms since
    # epoch, but Sentry custom events (performanceSpan, some breadcrumbs) use float SECONDS:
    # normalise to ms before sorting (observed with @sentry/react 11.11.0).
    events = [ev for seg in listed for ev in seg]
    def ts_ms(e):
        t = e.get("timestamp", 0) or 0
        return t * 1000 if t < 1e12 else t
    seconds_ts = sum(1 for e in events if 0 < (e.get("timestamp") or 0) < 1e12)
    ordered = sorted(events, key=ts_ms)
    rep["reassembled"] = {"events": len(events), "already_time_ordered": ordered == events,
                          "types": {str(k): sum(1 for e in events if e.get("type") == k) for k in sorted({e.get("type") for e in events})},
                          "custom_tags": sorted({e["data"].get("tag") for e in events if e.get("type") == 5}),
                          "events_with_seconds_timestamp": seconds_ts,
                          "first_ts_ms": ts_ms(ordered[0]) if ordered else None,
                          "last_ts_ms": ts_ms(ordered[-1]) if ordered else None}
    rep["complete"] = (not missing and len(listed) == n and rep["list_endpoint"]["empty_segments"] == 0
                       and not (rep.get("videos") or {}).get("size_or_magic_mismatch"))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        json.dump(ordered, open(f"{out_dir}/{replay_id}.rrweb.json", "w"))
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--org", default="sentry")
    ap.add_argument("--stats-period", default="30d")
    ap.add_argument("--replay", action="append", default=[])
    ap.add_argument("--per-page", type=int, default=100)
    ap.add_argument("--out")
    a = ap.parse_args()

    t = time.time()
    replays, pages = list_replays(a.org, a.stats_period, a.per_page)
    listing = {"replays": len(replays), "pages": pages, "seconds": round(time.time() - t, 3),
               "by_platform": {p: sum(1 for r in replays if r["platform"] == p) for p in sorted({r["platform"] for r in replays})}}
    chosen = a.replay
    if not chosen:
        web = [r for r in replays if r["platform"] == "javascript" and r["count_segments"] > 1]
        mobile = [r for r in replays if r["platform"] in ("cocoa", "android", "react-native", "java")]
        chosen = [x["id"] for x in (web[:1] + mobile[:1])]
    report = {"listing": listing, "replays": [pull_replay(a.org, r, a.per_page, a.out) for r in chosen], "http": STATS}
    report["http"]["seconds"] = round(report["http"]["seconds"], 3)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
