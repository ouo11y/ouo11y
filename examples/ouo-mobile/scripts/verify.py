#!/usr/bin/env python3
"""Verify an ouo-mobile journey (scripts/run.sh writes journey.json).

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--loki URL] [--rum-api URL]

Checks, for the journey's time window:
  - rum-api has the app's session (service mobile-store) with traces and a failed request;
  - trace continuity from the app to the backend (../tools/tracecheck.py, checklist N24): every
    request in the backend's log is a sampled trace in Tempo, no orphan parents, one trace id from
    the SDK's fetch span to the backend's server span, session.id from baggage on backend spans, no
    dropped trace, CORS for traceparent / tracestate / baggage, no Sentry bridge in the window.
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--journey", default="journey.json")
    ap.add_argument("--tempo", default=os.environ.get("OUO_TEMPO_URL", "http://localhost:3200"))
    ap.add_argument("--loki", default=os.environ.get("OUO_LOKI_URL", "http://localhost:3100"))
    ap.add_argument("--rum-api", default=os.environ.get("OUO_RUM_API_URL", "http://localhost:8080"))
    ap.add_argument("--read-token", default=os.environ.get("OUO_READ_TOKEN", "rt_dev_0000000000000000"))
    ap.add_argument("--min-failed", type=int, default=2, help="failed requests the journey makes (broken-card checkout, 500)")
    ap.add_argument("--vitals", action="store_true", help="also require mobile vitals on the session")
    a = ap.parse_args()
    j = json.load(open(a.journey))
    res = tracecheck.Result()
    tracecheck.run(tempo=a.tempo.rstrip("/"), loki=a.loki.rstrip("/"), backend_url=j["backend"], clients=[CLIENT],
                   path="ouo", start=j["start"], end=j["end"], res=res)

    ss = rumcheck.check_sessions(a.rum_api, a.read_token, CLIENT, j["start"], j["end"], res)
    failed_reqs = 0
    for s in ss:
        d = rumcheck.get(a.rum_api, f"/v1/sessions/{s['session_id']}", a.read_token)
        failed_reqs += sum(1 for e in d.get("timeline", []) if e.get("type") == "http.request.failed")
    res.add("failed requests on the timeline (broken-card checkout, 500)", failed_reqs >= a.min_failed, f"{failed_reqs}")
    if a.vitals:
        rumcheck.check_vitals(a.rum_api, a.read_token, ss, res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
