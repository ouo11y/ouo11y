#!/usr/bin/env python3
"""Verify an ouo-mobile journey (scripts/run.sh writes journey.json).

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--loki URL] [--rum-api URL]

Checks, for the journey's time window:
  - rum-api has the app's session (service mobile-store) with traces and a failed request;
  - trace continuity from the app to the backend (../tools/tracecheck.py, checklist N24): every
    request in the backend's log is a sampled trace in Tempo, no orphan parents, one trace id from
    the SDK's fetch span to the backend's server span, session.id from baggage on backend spans, no
    dropped trace, CORS for traceparent / tracestate / baggage, no Sentry bridge in the window;
  - with --feedback, the journey's feedback on the Cart screen (mobile SDK spec C10): message, contact, the steps before
    it in ouo.last_events (the cart screen among them), and with replay the screenshot flag and a replay
    that covers its time (the frame on screen then, and frames after it).
Mobile vitals are not checked here until @ouo11y/react-native emits them (checklist G2,
docs/specs/mobile-vitals.md); `--vitals` turns the check on.
Defaults are the plain compose stack's ports; `scripts/run.sh --env <name>` passes an ouo-env's URLs.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
import rumcheck  # noqa: E402
import tracecheck  # noqa: E402

CLIENT = "mobile-store"


def check_feedback(a, feedback, res):
    """C10: one feedback with its text, the steps before it and, when replay records, its frame."""
    res.add("one feedback on the session (C10)", len(feedback) == 1, f"{len(feedback)}")
    if len(feedback) != 1:
        return
    s, f = feedback[0]
    attrs = f.get("attrs", {})
    res.add("feedback message and contact", attrs.get("ouo_feedback_message") == "The cart total looks wrong"
            and attrs.get("ouo_feedback_contact") == "qa@example.invalid", json.dumps({k: v for k, v in attrs.items() if k.startswith("ouo_feedback")}))
    try:
        steps = json.loads(attrs.get("ouo_last_events", "[]"))
    except ValueError:
        steps = []
    res.add("feedback carries the steps before it, the cart screen among them", any(e.get("name") == "navigation" and e.get("body", "").endswith("Cart") for e in steps),
            " | ".join(f"{e.get('name')} {e.get('body')}" for e in steps[-5:]))
    if not s.get("has_replay"):
        res.add("feedback screenshot (no replay recorded: skipped)", True, "")
        return
    at = rumcheck.epoch_ms(f["ts"])
    frames = rumcheck.get(a.rum_api, f"/v1/sessions/{s['session_id']}/replay/frames", a.read_token).get("frames", [])
    before = [at - x["ts"] for x in frames if x["ts"] <= at]
    after = [x["ts"] for x in frames if x["ts"] > at]
    res.add("feedback screenshot: flag set, the replay shows the screen at its time", attrs.get("ouo_feedback_screenshot") == "true" and bool(before) and bool(after),
            f"screenshot={attrs.get('ouo_feedback_screenshot')} frame on screen {min(before) if before else None} ms before it, {len(after)} frames after")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--journey", default="journey.json")
    ap.add_argument("--tempo", default=os.environ.get("OUO_TEMPO_URL", "http://localhost:3200"))
    ap.add_argument("--loki", default=os.environ.get("OUO_LOKI_URL", "http://localhost:3100"))
    ap.add_argument("--rum-api", default=os.environ.get("OUO_RUM_API_URL", "http://localhost:8080"))
    ap.add_argument("--read-token", default=os.environ.get("OUO_READ_TOKEN", "rt_dev_0000000000000000"))
    ap.add_argument("--min-failed", type=int, default=2, help="failed requests the journey makes (broken-card checkout, 500)")
    ap.add_argument("--vitals", action="store_true", help="also require mobile vitals on the session")
    ap.add_argument("--feedback", action="store_true", help="also require the journey's feedback (scripts/journey.sh sends one on the Cart screen)")
    a = ap.parse_args()
    j = json.load(open(a.journey))
    res = tracecheck.Result()
    tracecheck.run(tempo=a.tempo.rstrip("/"), loki=a.loki.rstrip("/"), backend_url=j["backend"], clients=[CLIENT],
                   path="ouo", start=j["start"], end=j["end"], res=res)

    ss = rumcheck.check_sessions(a.rum_api, a.read_token, CLIENT, j["start"], j["end"], res)
    failed_reqs = 0
    feedback = []
    for s in ss:
        d = rumcheck.get(a.rum_api, f"/v1/sessions/{s['session_id']}", a.read_token)
        failed_reqs += sum(1 for e in d.get("timeline", []) if e.get("type") == "http.request.failed")
        feedback += [(s, e) for e in d.get("timeline", []) if e.get("name") == "feedback"]
    res.add("failed requests on the timeline (broken-card checkout, 500)", failed_reqs >= a.min_failed, f"{failed_reqs}")
    if a.feedback:
        check_feedback(a, feedback, res)
    if a.vitals:
        rumcheck.check_vitals(a.rum_api, a.read_token, ss, res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
