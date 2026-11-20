#!/usr/bin/env python3
"""Verify an ouo-mobile journey (scripts/run.sh writes journey.json).

  python3 -I scripts/verify.py [--journey journey.json] [--tempo URL] [--loki URL]

Checks trace continuity from the app to the backend for the journey's time window
(../tools/tracecheck.py, checklist N24): every request in the backend's log is a sampled trace in
Tempo, no orphan parents, one trace id from the SDK's fetch span to the backend's server span,
session.id from baggage on backend spans, no dropped trace, CORS for traceparent / tracestate /
baggage, no Sentry bridge in the window.
Defaults are the plain compose stack's ports; `scripts/run.sh --env <name>` passes an ouo-env's URLs.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
import tracecheck  # noqa: E402

CLIENT = "mobile-store"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--journey", default="journey.json")
    ap.add_argument("--tempo", default=os.environ.get("OUO_TEMPO_URL", "http://localhost:3200"))
    ap.add_argument("--loki", default=os.environ.get("OUO_LOKI_URL", "http://localhost:3100"))
    a = ap.parse_args()
    j = json.load(open(a.journey))
    res = tracecheck.Result()
    tracecheck.run(tempo=a.tempo.rstrip("/"), loki=a.loki.rstrip("/"), backend_url=j["backend"], clients=[CLIENT],
                   path="ouo", start=j["start"], end=j["end"], res=res)
    failed = [n for n, ok, _ in res.checks if not ok]
    print(f"\n{len(res.checks) - len(failed)}/{len(res.checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
