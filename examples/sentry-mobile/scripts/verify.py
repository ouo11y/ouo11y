#!/usr/bin/env python3
"""Verify a sentry-mobile journey through the ouo Sentry bridge (scripts/run.sh writes journey.json).

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--loki URL] [--rum-api URL]

Checks, for the journey's time window:
  - rum-api has the bridged sessions (service sentry-demo, the bridge's service_name) with traces,
    and, when rum-api and the collector have mobile vitals, the app start and TTID of the first one;
  - trace continuity from the app to the backend (../tools/tracecheck.py, checklist N24): every
    request in the backend's log is a sampled trace in Tempo, no orphan parents (Sentry sends a
    random parent span id when no transaction is active), one trace id from the app's http.client
    span to the backend's server span, no dropped trace, CORS allows sentry-trace next to the W3C
    headers, every app span came through the bridge and no ouo SDK span is in the window.
Defaults are the plain compose stack's ports; `scripts/run.sh --env <name>` passes an ouo-env's URLs.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
import rumcheck  # noqa: E402
import tracecheck  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--journey", default="journey.json")
    ap.add_argument("--tempo", default=os.environ.get("OUO_TEMPO_URL", "http://localhost:3200"))
    ap.add_argument("--loki", default=os.environ.get("OUO_LOKI_URL", "http://localhost:3100"))
    ap.add_argument("--rum-api", default=os.environ.get("OUO_RUM_API_URL", "http://localhost:8080"))
    ap.add_argument("--read-token", default=os.environ.get("OUO_READ_TOKEN", "rt_dev_0000000000000000"))
    ap.add_argument("--service", default="sentry-demo", help="service.name the bridge gives the app (collector config)")
    a = ap.parse_args()
    j = json.load(open(a.journey))
    res = tracecheck.Result()
    tracecheck.run(tempo=a.tempo.rstrip("/"), loki=a.loki.rstrip("/"), backend_url=j["backend"], clients=[a.service],
                   path="sentry", start=j["start"], end=j["end"], res=res)

    ss = rumcheck.check_sessions(a.rum_api, a.read_token, a.service, j["start"], j["end"], res)
    rumcheck.check_vitals(a.rum_api, a.read_token, ss, res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
