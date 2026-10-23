"""rum-api checks shared by the examples' verify scripts (sessions, timeline, mobile vitals).

Python 3 standard library only. rum-api reads need the read token (`OUO_READ_TOKEN`, the compose
stack's default is rt_dev_0000000000000000).
"""

from __future__ import annotations

import datetime as dt
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from tracecheck import Result

VITAL_NAMES = ("ouo.app.start", "ouo.screen.display", "app.jank", "ouo.stall")


def get(base: str, path: str, token: str | None, params: dict | None = None):
    url = base.rstrip("/") + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def iso(unix: int) -> str:
    return dt.datetime.fromtimestamp(unix, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sessions(base: str, token: str | None, service: str, start: int, end: int, settle: int = 90) -> list[dict]:
    """Sessions of `service` that started in [start - 60 s, end], waiting for ingestion."""
    deadline, out, prev = time.time() + settle, [], -1
    while True:
        try:
            out = get(base, "/v1/sessions", token, {"from": iso(start - 60), "to": iso(end + 60), "service": service, "limit": 500}).get("sessions", [])
        except urllib.error.URLError:
            out = []
        if (out and len(out) == prev) or time.time() > deadline:
            return out
        prev = len(out)
        time.sleep(10)


def check_sessions(base: str, token: str | None, service: str, start: int, end: int, res: Result,
                   min_sessions: int = 1) -> list[dict]:
    print(f"rum-api ({base}, service {service})", flush=True)
    ss = sessions(base, token, service, start, end)
    res.add(f"at least {min_sessions} session(s) of {service} in rum-api", len(ss) >= min_sessions,
            f"{len(ss)}: " + ", ".join(f"{s['session_id'][:8]} {s.get('status')}" for s in ss[:6]))
    # trace_count is computed on the session detail, not in the list. rum-api caches a Tempo answer
    # for TEMPO_CACHE_TTL (60 s), also an empty one from before Tempo indexed the traces: retry past it.
    deadline = time.time() + 75
    while True:
        details = [get(base, f"/v1/sessions/{s['session_id']}", token) for s in ss[:20]]
        with_traces = [d for d in details if d.get("trace_count", 0) > 0]
        if with_traces or not details or time.time() > deadline:
            break
        time.sleep(15)
    res.add("sessions carry their traces", bool(with_traces), f"{len(with_traces)}/{len(details)} with traces")
    return ss


def check_vitals(base: str, token: str | None, ss: list[dict], res: Result) -> None:
    """Mobile vitals (docs/specs/mobile-vitals.md): the first session has an app start and a TTID.
    Skipped, not failed, on a rum-api without the vitals endpoint (released 0.3.0 images)."""
    if not ss:
        return
    first = min(ss, key=lambda s: s.get("started_at", ""))
    try:
        v = get(base, f"/v1/sessions/{first['session_id']}/vitals", token)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        # An unknown route answers {"error":"not found"}; an unknown session names the session.
        if e.code == 404 and "session not found" not in body:
            print("  [SKIP] mobile vitals: this rum-api has no /vitals endpoint (older than the vitals release)")
            return
        raise
    summary = v.get("summary", {})
    res.add("vitals: app start recorded", "app_start" in summary, json.dumps(summary.get("app_start")))
    res.add("vitals: time to initial display per screen", summary.get("screens", 0) >= 1,
            f"{summary.get('screens', 0)} screens, ttid {summary.get('ttid_ms')}")
