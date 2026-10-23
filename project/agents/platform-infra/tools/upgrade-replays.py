#!/usr/bin/env python3
"""Seed and fingerprint replays for the upgrade test (roadmap 8a, docs/operations/upgrade.md).

  upgrade-replays.py seed  --env /opt/ouo/deploy/compose/.env --golden <dir> [--run <id>]
  upgrade-replays.py check --env /opt/ouo/deploy/compose/.env --data /opt/ouo/deploy/data/rum-api --out before.json \
                           [--from 2026-10-23T09:00:00Z --to 2026-10-23T12:00:00Z]
  upgrade-replays.py diff  before.json after.json

seed posts, through the collector exactly as the SDKs do (HTTP Basic project credential):
  - two rrweb chunks for session upg-web-<run> (web SDK)                    -> :4319 /v1/replay/chunks
  - two frames chunks for session upg-frames-<run> (ouo mobile SDK, JPEG)   -> :4319 /v1/replay/chunks
  - every captured Sentry envelope of a golden journey, in order (Sentry RN
    8.30 Session Replay, mp4 segments; the bridge turns them into video chunks) -> :4320 /api/<id>/envelope/
check walks the replay store on disk to list every session, then reads each one through
rum-api with the read token (meta, events / frames / every video segment) and records a
sha256 per payload. With --from / --to it also records, for that fixed window, the session
health buckets (/v1/stats/health), every listed session's status and its detail (status,
trace count, has_replay, event count), so sessions, health and traces are compared too.
diff fails when a session of the first file is missing or reads
differently in the second. Python 3 standard library only (the VM has no pip).
"""
import argparse, base64, gzip, hashlib, json, os, sys, time, urllib.error, urllib.request

JPEG = base64.b64decode(  # 1x1 baseline JPEG
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////"
    "////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")


def load_env(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def req(method, url, body=None, headers=None):
    r = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_chunk(base, auth, chunk):
    body = gzip.compress(json.dumps(chunk).encode())
    code, out = req("POST", base + "/v1/replay/chunks", body,
                    {"Authorization": auth, "Content-Type": "application/json", "Content-Encoding": "gzip"})
    print(f"  chunk {chunk['session_id']} seq {chunk['seq']} kind {chunk.get('kind', 'rrweb')}: {code} {out[:120]!r}")
    if code >= 300:
        sys.exit(1)


def seed(a):
    env = load_env(a.env)
    pid, tok = env.get("OUO_PROJECT_ID", "demo"), env.get("OUO_PROJECT_TOKEN", "")
    auth = "Basic " + base64.b64encode(f"{pid}:{tok}".encode()).decode()
    replay = a.replay_url or f"http://127.0.0.1:{env.get('OUO_REPLAY_PORT', '4319')}"
    now = int(time.time() * 1000)
    run = a.run or str(now)
    web = f"upg-web-{run}"
    for seq in range(2):
        t = now - 60000 + seq * 10000
        ev = [{"type": 4, "timestamp": t, "data": {"href": "https://shop.example/", "width": 1280, "height": 800}},
              {"type": 2, "timestamp": t + 1, "data": {"node": {"type": 0, "id": 1, "childNodes": []}, "initialOffset": {"top": 0, "left": 0}}},
              {"type": 3, "timestamp": t + 500, "data": {"source": 1, "positions": [{"x": 10, "y": 20, "id": 1, "timeOffset": 0}]}}]
        post_chunk(replay, auth, {"session_id": web, "seq": seq, "started_at": t, "ended_at": t + 5000, "events": ev})
    fr = f"upg-frames-{run}"
    jpg = base64.b64encode(JPEG).decode()
    for seq in range(2):
        t = now - 50000 + seq * 10000
        post_chunk(replay, auth, {
            "kind": "frames", "schema_version": 1, "session_id": fr, "seq": seq, "started_at": t, "ended_at": t + 5000,
            "viewport": {"width": 393, "height": 852, "scale": 0.5}, "platform": "ios", "masked": True,
            "frames": [{"ts": t + i * 1000, "jpeg": jpg, "reason": "timer", "n": seq * 100 + i} for i in range(3)],
            "touches": [{"ts": t + 1500, "x": 120.5, "y": 640, "phase": "began"}, {"ts": t + 1600, "x": 121, "y": 641, "phase": "ended"}]})
    if a.golden:
        sentry = a.sentry_url or f"http://127.0.0.1:{env.get('OUO_SENTRY_PORT', '4320')}"
        key = env.get("OUO_SENTRY_PUBLIC_KEY", "publickey0000000000000000000000")
        n = videos = 0
        for d in sorted(os.listdir(a.golden)):
            meta = json.load(open(os.path.join(a.golden, d, "request.json")))
            body = open(os.path.join(a.golden, d, "body.bin"), "rb").read()
            hdr = {k: v[0] for k, v in meta["header"].items() if k.lower() in ("content-type", "content-encoding", "user-agent", "x-sentry-auth")}
            if "X-Sentry-Auth" in hdr:
                hdr["X-Sentry-Auth"] = hdr["X-Sentry-Auth"].replace("publickey0000000000000000000000", key)
            raw = gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
            videos += raw.count(b'"type":"replay_video"')
            code, out = req(meta["method"], sentry + meta["path"] + ("?" + meta["raw_query"] if meta["raw_query"] else ""), body, hdr)
            n += 1
            if code >= 300:
                print(f"  sentry {d} {meta['path']}: {code} {out[:200]!r}")
                sys.exit(1)
        print(f"  sentry: {n} envelopes posted ({videos} replay_video items), all 2xx")
    print(json.dumps({"web": web, "frames": fr, "run": run}))


def sha(b):
    return hashlib.sha256(b).hexdigest()


def check(a):
    env = load_env(a.env)
    rum = a.rum_url or f"http://127.0.0.1:{env.get('OUO_RUM_API_PORT', '8080')}"
    h = {"Authorization": "Bearer " + env.get("OUO_READ_TOKEN", "")}
    if a.ids:  # no access to the store's disk (Kubernetes PVC, S3): ids listed some other way
        ids = sorted(l.strip() for l in open(a.ids) if l.strip())
    else:
        root = os.path.join(a.data, "replays")
        ids = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    out = {}
    for sid in ids:
        if sid.startswith("@"):
            continue
        code, b = req("GET", f"{rum}/v1/sessions/{sid}/replay", headers=h)
        rec = {"meta_status": code}
        if code == 200:
            m = json.loads(b)
            kind = m.get("kind", "rrweb")
            rec.update(kind=kind, chunks=m.get("chunk_count"), project_id=m.get("project_id"), bytes=m.get("bytes"))
            if kind == "video":
                rec["segments"] = {}
                for c in m.get("chunks", []):
                    c2, v = req("GET", f"{rum}/v1/sessions/{sid}/replay/video/{c['seq']}", headers=h)
                    rec["segments"][str(c["seq"])] = [c2, len(v), sha(v), v[4:8].decode("latin1")]
            else:
                path = "events" if kind == "rrweb" else "frames"
                c2, v = req("GET", f"{rum}/v1/sessions/{sid}/replay/{path}", headers=h)
                rec["payload"] = [c2, len(v), sha(v)]
        out[sid] = rec
        print(sid, json.dumps(rec)[:200])
    bad = [s for s, r in out.items() if r["meta_status"] != 200]
    if a.frm:
        q = f"from={a.frm}&to={a.to}"
        code, b = req("GET", f"{rum}/v1/stats/health?{q}", headers=h)
        out["@health"] = {"status": code, "body": json.loads(b) if code == 200 else b.decode()[:200]}
        code, b = req("GET", f"{rum}/v1/sessions?{q}&limit=1000", headers=h)
        lst = json.loads(b) if code == 200 else {}
        rows = lst.get("sessions", lst if isinstance(lst, list) else [])
        out["@sessions"] = {"status": code, "count": len(rows)}
        for row in rows:
            sid = row["session_id"]
            c2, d = req("GET", f"{rum}/v1/sessions/{sid}?{q}", headers=h)
            det = json.loads(d) if c2 == 200 else {}
            out["@session " + sid] = {"list_status": row.get("status"), "detail_status": c2, "status": det.get("status"),
                                      "trace_count": det.get("trace_count", len(det.get("traces") or [])), "traces": len(det.get("traces") or []), "has_replay": det.get("has_replay"),
                                      "events": len(det.get("timeline", det.get("events", [])) or [])}
        print(f"health {out['@health']['status']} {json.dumps(out['@health']['body'])[:300]}")
        print(f"sessions listed: {len(rows)}; with traces: {sum(1 for k, v in out.items() if k.startswith('@session ') and v['trace_count'])}")
        bad += [k for k, v in out.items() if k.startswith("@session ") and v["detail_status"] != 200]
    json.dump(out, open(a.out, "w"), indent=1, sort_keys=True)
    print(f"{sum(1 for k in out if not k.startswith('@'))} replays, {len(bad)} unreadable {bad}")
    sys.exit(1 if bad else 0)


def diff(a):
    x, y = json.load(open(a.before)), json.load(open(a.after))
    bad = []
    for sid, r in x.items():
        if sid not in y:
            bad.append(f"{sid}: missing after")
        elif {k: v for k, v in r.items()} != {k: v for k, v in y[sid].items()}:
            bad.append(f"{sid}: before {json.dumps(r)[:300]} after {json.dumps(y[sid])[:300]}")
    kinds = {}
    for k, r in x.items():
        if k.startswith("@"):
            continue
        kinds[r.get("kind")] = kinds.get(r.get("kind"), 0) + 1
    print(f"{sum(kinds.values())} replays before {kinds}, {sum(1 for k in y if not k.startswith('@'))} after; "
          f"{sum(1 for k in x if k.startswith('@session '))} sessions and the health buckets compared; {len(bad)} entries differ")
    for b in bad:
        print("  " + b)
    sys.exit(1 if bad else 0)


p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sp = p.add_subparsers(dest="cmd", required=True)
s = sp.add_parser("seed"); s.add_argument("--env", required=True); s.add_argument("--golden"); s.add_argument("--run")
s.add_argument("--replay-url"); s.add_argument("--sentry-url"); s.set_defaults(f=seed)
c = sp.add_parser("check"); c.add_argument("--env", required=True); g = c.add_mutually_exclusive_group(required=True)
g.add_argument("--data", help="rum-api DATA_DIR on this host"); g.add_argument("--ids", help="file with one replay session id per line")
c.add_argument("--out", required=True); c.add_argument("--rum-url")
c.add_argument("--from", dest="frm"); c.add_argument("--to"); c.set_defaults(f=check)
d = sp.add_parser("diff"); d.add_argument("before"); d.add_argument("after"); d.set_defaults(f=diff)
a = p.parse_args()
a.f(a)
