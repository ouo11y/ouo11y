#!/usr/bin/env python3
"""Verify an ouo-web journey (scripts/journey.mjs) end to end.

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--rum-api URL] [--read-token T]

Checks:
  - rum-api has the journey's session (service web-store) with its timeline and traces;
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
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
import tracecheck  # noqa: E402

CLIENT = "web-store"


def rum_get(base, path, token):
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


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

    tracecheck.run(tempo=a.tempo.rstrip("/"), backend_url=j["backend"], clients=[CLIENT], path="ouo",
                   start=j["start"], end=j["end"], expect_requests=j["requests"], expect_traces=j["requests"],
                   origin=origin, loki=a.loki.rstrip("/"), res=res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
