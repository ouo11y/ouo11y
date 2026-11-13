#!/usr/bin/env python3
"""Verify an ouo-web journey (scripts/journey.mjs) end to end.

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--rum-api URL] [--read-token T]

Checks:
  - Loki, the wire of the client SDK spec 0.1.0-draft: one `session.start`; `ouo.view.id`, a 32-hex
    `session.id` and a sanitised `browser.document.url.full` on every record; no deprecated MVP names;
    every Web Vital the journey's engine supports as `browser.web_vital` (journey `vitals`); clicks as
    `browser.user_action.click`; a dead and a rage click as `ouo.user_action.frustration`; the error
    boundary's `exception` with its debug ids; `ouo.view.name` from the route hook; replay as
    `ouo.replay.chunk` records in sequence with one `ouo.replay.ended`;
  - Tempo: every backend request is a client span in a trace of its own, nothing is a `click` or
    `soft-navigation` span, and one `documentLoad` span exists;
  - trace continuity from the browser to the backend (../tools/tracecheck.py): no orphan parents, one
    trace id, session.id from baggage on backend spans, one backend span per request the journey sent,
    every request in the backend's own log a sampled trace in Tempo, CORS for traceparent / tracestate /
    baggage, no Sentry bridge;
  - rum-api (the MVP read path): the journey's session with its timeline and traces, and the render
    error symbolicated back to src/components/ChaosPanel.tsx. rum-api folds the MVP event names, so
    these checks describe what the MVP read path still has to learn about the spec wire.
Defaults are the plain compose stack's ports; `scripts/run.sh --env <name>` passes an ouo-env's URLs.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
import tracecheck  # noqa: E402

CLIENT = "web-store"


def rum_get(base, path, token):
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def loki_events(loki, sid, start, end):
    """Log records of the session: (event_name, attributes from stream labels and structured metadata)."""
    q = urllib.parse.urlencode({
        "query": f'{{service_name="{CLIENT}"}} | session_id="{sid}"',
        "start": str(start * 10**9), "end": str((end + 120) * 10**9), "limit": "5000", "direction": "forward",
    })
    doc = tracecheck.http_json(f"{loki}/loki/api/v1/query_range?{q}")
    return [(st["stream"].get("event_name", ""), st["stream"]) for st in doc["data"]["result"] for _ in st["values"]]


MVP_NAMES = {"web_vital", "navigation", "http.request.failed", "ouo.dead_click", "ouo.rage_click", "ouo.long_animation_frame", "ouo.long_task"}


def check_browser_signals(a, j, sid, res):
    print(f"browser signals ({j.get('browser', 'chromium')}, Loki {a.loki})", flush=True)
    want_vitals = {v.lower() for v in (j.get("vitals") or ["TTFB", "FCP", "LCP", "CLS", "INP"])}
    events, deadline = [], time.time() + 60
    while time.time() < deadline:
        events = loki_events(a.loki.rstrip("/"), sid, j["start"], j["end"])
        vitals = {attrs.get("browser_web_vital_name") for name, attrs in events if name == "browser.web_vital"}
        if want_vitals <= vitals:
            break
        time.sleep(5)
    names = [n for n, _ in events]
    by = lambda name: [attrs for n, attrs in events if n == name]  # noqa: E731
    telemetry = [(n, attrs) for n, attrs in events if not n.startswith("ouo.replay")]

    res.add("one session.start with the sample rate", len(by("session.start")) == 1 and by("session.start")[0].get("ouo_session_sample_rate") is not None,
            f"{len(by('session.start'))} session.start")
    res.add("session.id is 32 lowercase hex", len(sid) == 32 and all(c in "0123456789abcdef" for c in sid), sid)
    res.add("every record has ouo.view.id and the document URL", all(attrs.get("ouo_view_id") and attrs.get("browser_document_url_full") for _, attrs in telemetry),
            f"{len(telemetry)} records")
    res.add("every record is on scope ouo.rum (replay on ouo.replay)",
            all(attrs.get("scope_name") == ("ouo.replay" if n.startswith("ouo.replay") else "ouo.rum") for n, attrs in events),
            f"{sorted({attrs.get('scope_name') for _, attrs in events})}")
    res.add("no MVP event names on the wire", not (set(names) & MVP_NAMES), f"{sorted(set(names) & MVP_NAMES)}")
    res.add("no anonymous user id, no device id", all(not attrs.get("user_id") and not attrs.get("device_id") for _, attrs in events))

    vitals = {attrs.get("browser_web_vital_name") for attrs in by("browser.web_vital")}
    res.add("every Web Vital this engine supports, once each", want_vitals <= vitals and len(by("browser.web_vital")) == len(vitals),
            f"want {sorted(want_vitals)}, got {sorted(v for v in vitals if v)} in {len(by('browser.web_vital'))} events")
    res.add("clicks as browser.user_action.click with a selector and no text",
            len(by("browser.user_action.click")) >= 10 and all(attrs.get("browser_css_selector") and attrs.get("browser_tag_name") for attrs in by("browser.user_action.click")),
            f"{len(by('browser.user_action.click'))} clicks")
    frustration = {attrs.get("ouo_user_action_frustration_type"): attrs for attrs in by("ouo.user_action.frustration")}
    res.add("dead click on the Chaos dead button", "dead" in frustration, f"{sorted(frustration)}")
    res.add("rage click (4 fast clicks)", int(frustration.get("rage", {}).get("ouo_user_action_frustration_click_count", 0)) >= 4, f"{sorted(frustration)}")
    boundary = [attrs for attrs in by("exception") if attrs.get("ouo_react_component_stack")]
    res.add("render error reported by OuoErrorBoundary (manual, handled)",
            bool(boundary) and boundary[0].get("ouo_exception_source") == "manual" and boundary[0].get("ouo_exception_handled") == "true",
            f"{len(boundary)} exception(s) with a component stack")
    res.add("render error carries the bundle's debug id (ouo.exception.debug_ids)", bool(boundary) and bool(boundary[0].get("ouo_exception_debug_ids")))
    views = {attrs.get("ouo_view_name") for _, attrs in events if attrs.get("ouo_view_name")}
    res.add("route names from useOuoRoute (ouo.view.name)", {"/products/:id", "/chaos"} <= views, f"{sorted(views)}")
    nav = by("browser.navigation")
    res.add("one hard navigation, then soft navigations, each a new view",
            sum(1 for n in nav if n.get("browser_navigation_same_document") == "false") == 1 and len({n.get("ouo_view_id") for n in nav}) == len(nav) >= 8,
            f"{len(nav)} browser.navigation")

    chunks = sorted(by("ouo.replay.chunk"), key=lambda c: (c.get("ouo_replay_stream_id", ""), int(c.get("ouo_replay_sequence", -1))))
    streams = {}
    for c in chunks:
        streams.setdefault(c.get("ouo_replay_stream_id"), []).append(int(c.get("ouo_replay_sequence", -1)))
    res.add("replay: ouo.replay.chunk records, sequence from 0 with no gap, first chunk a keyframe",
            bool(chunks) and all(sorted(set(seqs)) == list(range(len(set(seqs)))) for seqs in streams.values())
            and all(c.get("ouo_replay_keyframe") == "true" for c in chunks if c.get("ouo_replay_sequence") == "0"),
            f"{len(chunks)} chunk(s) in {len(streams)} stream(s), format {sorted({c.get('ouo_replay_format') for c in chunks})}")
    res.add("replay: every chunk has its identity, hash and masked flag",
            all(c.get("ouo_replay_id") and c.get("ouo_replay_sha256") and c.get("ouo_replay_masked") == "true" and c.get("ouo_replay_mode") for c in chunks))
    res.add("replay: one ouo.replay.ended per stream", len(by("ouo.replay.ended")) == len(streams) >= 1, f"{len(by('ouo.replay.ended'))} ended")
    print(f"  events: {', '.join(sorted(set(names)))}", flush=True)


# Where ChaosPanel's RenderBomb throws (src/components/ChaosPanel.tsx).
BOMB_FILE, BOMB_LINE = "src/components/ChaosPanel.tsx", 18


def check_symbolication(a, detail, res):
    print("source maps (rum-api symbolication)", flush=True)
    boundary = [e for e in (detail or {}).get("timeline", [])
                if e.get("name") == "exception" and e.get("attrs", {}).get("ouo_react_component_stack")]
    ev = boundary[0] if boundary else {}
    attrs = ev.get("attrs", {})
    try:
        debug_ids = json.loads(attrs.get("ouo_exception_debug_ids") or "{}")
    except ValueError:
        debug_ids = {}
    res.add("render error carries the bundle's debug id (ouo.exception.debug_ids)", bool(debug_ids), f"{debug_ids}")
    sym = ev.get("symbolicated") or {}
    frames = sym.get("frames") or []
    top = (frames[0].get("original") or {}) if frames else {}
    res.add(f"top frame symbolicated to {BOMB_FILE}:{BOMB_LINE}",
            top.get("file") == BOMB_FILE and top.get("line") == BOMB_LINE,
            f"status {sym.get('status')}, mapped {sym.get('mapped')}/{len(frames)}, top {top}")
    res.add("top frame's function and source line are the original ones",
            top.get("function") == "RenderBomb" and "throw new Error" in ((frames[0].get("context") or {}).get("line", "") if frames else ""),
            f"function {top.get('function')!r}")
    raw = attrs.get("exception_stacktrace", "")
    res.add("raw minified stack kept in attrs", "/assets/" in raw and BOMB_FILE not in raw, raw.splitlines()[1].strip() if "\n" in raw else raw[:80])


def check_interactions(a, j, sid, res):
    print(f"spans (Tempo {a.tempo})", flush=True)
    tempo = a.tempo.rstrip("/")
    spans, deadline = [], time.time() + 60
    while time.time() < deadline:
        ids = tracecheck.tempo_search(tempo, f'{{ span.session.id = "{sid}" && resource.service.name = "{CLIENT}" }}', j["start"], j["end"] + 120)
        spans = [s for trace in tracecheck.fetch_traces(tempo, ids).values() for s in trace if s.service == CLIENT]
        if sum(1 for s in spans if tracecheck.span_url(s).startswith(j["backend"])) >= j["requests"] and any(s.name == "documentLoad" for s in spans):
            break
        time.sleep(5)
    requests = [s for s in spans if tracecheck.span_url(s).startswith(j["backend"])]
    res.add("every backend request is a client span in a trace of its own",
            len(requests) >= j["requests"] and len({s.trace_id for s in requests}) == len(requests) and all(not s.parent_id for s in requests),
            f"{len(requests)} spans in {len({s.trace_id for s in requests})} traces")
    res.add("no click or soft-navigation spans", not [s for s in spans if s.name in ("click", "soft-navigation", "documentFetch", "resourceFetch")],
            f"{sorted({s.name for s in spans})}")
    res.add("one documentLoad span", sum(1 for s in spans if s.name == "documentLoad") == 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--journey", default="journey.json")
    ap.add_argument("--tempo", default=os.environ.get("OUO_TEMPO_URL", "http://localhost:3200"))
    ap.add_argument("--loki", default=os.environ.get("OUO_LOKI_URL", "http://localhost:3100"))
    ap.add_argument("--rum-api", default=os.environ.get("OUO_RUM_API_URL", "http://localhost:8080"))
    ap.add_argument("--read-token", default=os.environ.get("OUO_READ_TOKEN", "rt_dev_0000000000000000"))
    ap.add_argument("--origin", default=None, help="Origin for the CORS preflight (default: the journey's page origin)")
    a = ap.parse_args()
    j = json.load(open(a.journey))
    origin = a.origin or "/".join(j["url"].split("/")[:3])
    res = tracecheck.Result()

    print(f"rum-api ({a.rum_api})", flush=True)
    sid = (j.get("sessions") or [None])[0]
    res.add("journey recorded its session id", bool(sid))
    if sid:
        detail, deadline = None, time.time() + 90
        while time.time() < deadline:
            try:
                detail = rum_get(a.rum_api, f"/v1/sessions/{sid}", a.read_token)
                if detail.get("trace_count", 0) > 0 and len(detail.get("timeline", [])) > 1:
                    break
            except Exception:
                pass
            time.sleep(5)
        res.add("session in rum-api with service web-store", bool(detail) and detail.get("service_name") == CLIENT,
                f"{(detail or {}).get('service_name')}")
        res.add("session has a timeline and traces", bool(detail) and detail.get("trace_count", 0) > 0 and len(detail.get("timeline", [])) > 1,
                f"trace_count {(detail or {}).get('trace_count')}, timeline {len((detail or {}).get('timeline', []))}")
        check_browser_signals(a, j, sid, res)
        check_symbolication(a, rum_get(a.rum_api, f"/v1/sessions/{sid}", a.read_token), res)
        check_interactions(a, j, sid, res)

    tracecheck.run(tempo=a.tempo.rstrip("/"), backend_url=j["backend"], clients=[CLIENT], path="ouo",
                   start=j["start"], end=j["end"], expect_requests=j["requests"], expect_traces=j.get("traces", j["requests"]),
                   origin=origin, loki=a.loki.rstrip("/"), res=res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
