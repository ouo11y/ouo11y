#!/usr/bin/env python3
"""Verify an ouo-web journey (scripts/journey.mjs) end to end.

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--rum-api URL] [--read-token T]

Checks:
  - rum-api has the journey's session (service web-store) with its timeline and traces;
  - Loki: every Web Vital the journey's engine supports (journey `vitals`; FCP, LCP, CLS, INP, TTFB in
    Chromium), the dead and rage clicks, the error boundary's exception, `app.screen.name` from the
    route hook, and in Chromium a long animation frame (checklist N10, N25);
  - source maps (ADR-0011): the render error carries `ouo.exception.debug_ids`, and rum-api's session
    detail symbolicates its top frame back to src/components/ChaosPanel.tsx line 18 (RenderBomb), with
    the original source line; the raw minified stack stays in attrs (run.sh uploads the maps);
  - Tempo: a `click` span is the parent of a fetch span to the backend, and a `soft-navigation` span
    exists (interaction tracing, soft navigations);
  - trace continuity from the browser to the backend (../tools/tracecheck.py, checklist N24): no orphan
    parents, one trace id, session.id from baggage on backend spans, one backend span per request the
    journey sent, every request in the backend's own log a sampled trace in Tempo (no dropped trace), CORS for traceparent / tracestate / baggage, no Sentry bridge.
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


def check_browser_signals(a, j, sid, res):
    print(f"browser signals ({j.get('browser', 'chromium')}, Loki {a.loki})", flush=True)
    want_vitals = set(j.get("vitals") or ["TTFB", "FCP", "LCP", "CLS", "INP"])
    events, deadline = [], time.time() + 60
    while time.time() < deadline:
        events = loki_events(a.loki.rstrip("/"), sid, j["start"], j["end"])
        vitals = {attrs.get("ouo_web_vital_name") for name, attrs in events if name == "web_vital"}
        if want_vitals <= vitals:
            break
        time.sleep(5)
    names = [n for n, _ in events]
    vitals = {attrs.get("ouo_web_vital_name") for name, attrs in events if name == "web_vital"}
    res.add("every Web Vital this engine supports", want_vitals <= vitals,
            f"want {sorted(want_vitals)}, got {sorted(v for v in vitals if v)}")
    dead = [attrs for name, attrs in events if name == "ouo.dead_click"]
    res.add("dead click on the Chaos dead button", any(attrs.get("app_widget_name", "").startswith("Dead button") for attrs in dead),
            f"{len(dead)} ouo.dead_click")
    rage = [attrs for name, attrs in events if name == "ouo.rage_click"]
    res.add("rage click (4 fast clicks)", any(int(attrs.get("ouo_click_count", 0)) >= 3 for attrs in rage), f"{len(rage)} ouo.rage_click")
    boundary = [attrs for name, attrs in events if name == "exception" and attrs.get("ouo_exception_kind") == "react.error_boundary"]
    res.add("render error reported by OuoErrorBoundary", bool(boundary) and bool(boundary[0].get("ouo_react_component_stack")),
            f"{len(boundary)} exception(s) of kind react.error_boundary")
    screens = {attrs.get("app_screen_name") for _, attrs in events if attrs.get("app_screen_name")}
    res.add("route names from useOuoRoute (app.screen.name)", {"/products/:id", "/chaos"} <= screens, f"{sorted(screens)}")
    if j.get("loaf"):
        loaf = [attrs for name, attrs in events if name == "ouo.long_animation_frame"]
        res.add("long animation frame from the 300 ms task", any(float(attrs.get("ouo_long_task_duration_ms", 0)) >= 250 for attrs in loaf),
                f"{len(loaf)} ouo.long_animation_frame")
    if "INP" in want_vitals:
        # The visit's INP is its slowest interaction: the 300 ms long task (`button.btn.chaos-btn`, the
        # click events' app.widget.id; no text), mostly processing time, with its LoAF script in Chromium.
        inp = [attrs for name, attrs in events if name == "web_vital" and attrs.get("ouo_web_vital_name") == "INP"]
        slow = max(inp, key=lambda x: float(x.get("ouo_web_vital_value", 0)), default={})
        res.add("INP attributed to the long-task button (target, phases)",
                slow.get("ouo_web_vital_inp_target") == CHAOS_BUTTON and float(slow.get("ouo_web_vital_inp_processing_duration_ms", 0)) >= 250
                and "ouo_web_vital_inp_input_delay_ms" in slow and "ouo_web_vital_inp_presentation_delay_ms" in slow,
                f"INP {slow.get('ouo_web_vital_value')} target {slow.get('ouo_web_vital_inp_target')} processing {slow.get('ouo_web_vital_inp_processing_duration_ms')}")
        if j.get("loaf"):
            res.add("INP carries the Long Animation Frame script", "BUTTON" in slow.get("ouo_web_vital_inp_script_invoker", ""),
                    f"invoker {slow.get('ouo_web_vital_inp_script_invoker')}, subpart {slow.get('ouo_web_vital_inp_script_subpart')}")
    print(f"  events: {', '.join(sorted(set(names)))}", flush=True)


# The chaos buttons' INP target (and app.widget.id): tag and classes, no id or data-testid.
CHAOS_BUTTON = "button.btn.chaos-btn"


def check_inp_targets(a, j, res):
    print("slowest interactions (rum-api /v1/vitals/inp/targets)", flush=True)
    q = urllib.parse.urlencode({"service": CLIENT, "from": j["start"], "to": j["end"] + 120, "page": "/chaos"})
    groups, deadline = [], time.time() + 60
    while time.time() < deadline:
        groups = rum_get(a.rum_api, f"/v1/vitals/inp/targets?{q}", a.read_token).get("groups", [])
        if any(g["target"] == CHAOS_BUTTON for g in groups):
            break
        time.sleep(5)
    g = next((g for g in groups if g["target"] == CHAOS_BUTTON), None)
    res.add("p75 INP of the long-task button on /chaos",
            bool(g) and g["page"] == "/chaos" and g["p75_ms"] >= 250 and (g["processing_duration_p75_ms"] or 0) >= 250,
            f"{g}" if g else f"{len(groups)} groups: {[x['target'] for x in groups]}")


# Where ChaosPanel's RenderBomb throws (src/components/ChaosPanel.tsx).
BOMB_FILE, BOMB_LINE = "src/components/ChaosPanel.tsx", 18


def check_symbolication(a, detail, res):
    print("source maps (rum-api symbolication)", flush=True)
    boundary = [e for e in (detail or {}).get("timeline", [])
                if e.get("name") == "exception" and e.get("attrs", {}).get("ouo_exception_kind") == "react.error_boundary"]
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
    print(f"interaction tracing (Tempo {a.tempo})", flush=True)
    tempo = a.tempo.rstrip("/")
    ids, parented, navs, deadline = [], 0, 0, time.time() + 60
    while time.time() < deadline:
        ids = tracecheck.tempo_search(tempo, f'{{ span.session.id = "{sid}" && name = "click" }}', j["start"], j["end"] + 120)
        parented, navs = 0, 0
        for spans in tracecheck.fetch_traces(tempo, ids).values():
            by_id = {s.span_id: s for s in spans}
            for s in spans:
                if s.name == "soft-navigation":
                    navs += 1
                parent = by_id.get(s.parent_id)
                if tracecheck.span_url(s).startswith(j["backend"]) and parent is not None and parent.name in ("click", "soft-navigation"):
                    parented += 1
        if parented and navs:
            break
        time.sleep(5)
    res.add("click spans parent the backend requests they cause", parented > 0, f"{len(ids)} click traces, {parented} backend fetch spans under a click or soft navigation")
    res.add("soft-navigation spans under clicks", navs > 0, f"{navs} soft-navigation spans")


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
        res.add("one failed request recorded (broken-card checkout)", bool(detail) and any(e.get("type") == "http.request.failed" for e in detail.get("timeline", [])))
        check_browser_signals(a, j, sid, res)
        check_symbolication(a, rum_get(a.rum_api, f"/v1/sessions/{sid}", a.read_token), res)
        check_interactions(a, j, sid, res)
        if "INP" in (j.get("vitals") or []):
            check_inp_targets(a, j, res)

    tracecheck.run(tempo=a.tempo.rstrip("/"), backend_url=j["backend"], clients=[CLIENT], path="ouo",
                   start=j["start"], end=j["end"], expect_requests=j["requests"], expect_traces=j.get("traces", j["requests"]),
                   origin=origin, loki=a.loki.rstrip("/"), res=res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
