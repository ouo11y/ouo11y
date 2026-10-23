#!/usr/bin/env python3
"""A Linux stand-in for the app's journey, for CI (no iOS Simulator there).

Does what @sentry/react-native 8.x does on the wire for a short journey, with the example's
Sentry.init (tracesSampleRate 1.0, propagateTraceparent, tracePropagationTargets = the backend):

  - a session init and the first screen's `ui.load` transaction (app start, TTID), then per request a `ui.action` transaction whose `http.client` span called the
    backend with `traceparent`, `sentry-trace` and `baggage` (the span id of the http.client span is
    the parent the backend sees), sent to the bridge after the request as the SDK does;
  - a session `exited` update at the end.

Then writes journey.json for scripts/verify.py. The shapes follow the golden captures in
collector/receiver/ouosentryreceiver/testdata/golden/; the iOS run (scripts/run.sh) is the real test.

  python3 -I scripts/ci-journey.py [--bridge http://localhost:4320] [--backend http://localhost:8081] [--requests 6]
"""

import argparse
import json
import secrets
import sys
import time
import urllib.request
import uuid


def rfc3339(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t % 1 * 1000):03d}Z"

KEY = "publickey0000000000000000000000"
PROJECT = "1"
SDK = {"name": "sentry.javascript.react-native", "version": "8.32.0"}
RELEASE = "sentry-demo@1.0.0+1"


def envelope(header: dict, *items) -> bytes:
    out = [json.dumps(header)]
    for typ, payload in items:
        body = json.dumps(payload)
        out += [json.dumps({"type": typ, "length": len(body.encode())}), body]
    return ("\n".join(out) + "\n").encode()


def send(bridge: str, body: bytes) -> None:
    req = urllib.request.Request(f"{bridge}/api/{PROJECT}/envelope/", data=body, method="POST", headers={
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": f"Sentry sentry_version=7, sentry_client={SDK['name']}/{SDK['version']}, sentry_key={KEY}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bridge", default="http://localhost:4320")
    ap.add_argument("--backend", default="http://localhost:8081")
    ap.add_argument("--requests", type=int, default=6)
    ap.add_argument("--out", default="journey.json")
    a = ap.parse_args()
    start = int(time.time()) - 1
    sid, did = str(uuid.uuid4()).upper(), str(uuid.uuid4()).upper()
    t0 = time.time()
    session = {"sid": sid, "did": did, "init": True, "started": rfc3339(t0),
               "timestamp": rfc3339(t0), "status": "ok", "errors": 0,
               "attrs": {"release": RELEASE, "environment": "development"}}
    send(a.bridge, envelope({"sdk": SDK}, ("session", session)))
    contexts = {"os": {"name": "iOS", "version": "27.0"}, "device": {"model": "iPhone18,1"}}
    # The first screen: a `ui.load` transaction that starts at process start, with the app start
    # and time to initial display measurements (mobile vitals, docs/specs/mobile-vitals.md).
    load = {"type": "transaction", "transaction": "Home", "platform": "javascript", "release": RELEASE,
            "environment": "development", "start_timestamp": t0 - 1.2, "timestamp": t0 + 0.3, "user": {"id": did}, "sdk": SDK,
            "contexts": {**contexts, "trace": {"trace_id": secrets.token_hex(16), "span_id": secrets.token_hex(8), "op": "ui.load", "status": "ok"}},
            "spans": [], "measurements": {"app_start_cold": {"value": 1150.0, "unit": "millisecond"},
                                          "time_to_initial_display": {"value": 1480.0, "unit": "millisecond"}}}
    send(a.bridge, envelope({"event_id": uuid.uuid4().hex, "sdk": SDK}, ("transaction", load)))
    for i in range(a.requests):
        trace, root, http = secrets.token_hex(16), secrets.token_hex(8), secrets.token_hex(8)
        path = "/api/products" if i % 3 else "/api/cart"
        url = a.backend + path
        tx_start = time.time()
        req = urllib.request.Request(url, headers={
            "traceparent": f"00-{trace}-{http}-01", "sentry-trace": f"{trace}-{http}-1",
            "baggage": f"sentry-trace_id={trace},sentry-sample_rate=1,sentry-sampled=true,sentry-release={RELEASE}"})
        h_start = time.time()
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
            status = r.status
        h_end = time.time()
        tx = {"type": "transaction", "transaction": f"action {i}", "platform": "javascript", "release": RELEASE,
              "environment": "development", "start_timestamp": tx_start, "timestamp": h_end + 0.01,
              "user": {"id": did}, "sdk": SDK,
              "contexts": {**contexts, "trace": {"trace_id": trace, "span_id": root, "op": "ui.action", "status": "ok"}},
              "spans": [{"trace_id": trace, "span_id": http, "parent_span_id": root, "op": "http.client",
                         "description": f"GET {url}", "start_timestamp": h_start, "timestamp": h_end, "status": "ok",
                         "data": {"http.method": "GET", "url": url, "http.response.status_code": status}}],
              "measurements": {"frames_total": {"value": 12, "unit": "none"}, "frames_slow": {"value": 1, "unit": "none"},
                               "frames_frozen": {"value": 0, "unit": "none"}}}
        send(a.bridge, envelope({"event_id": uuid.uuid4().hex, "sdk": SDK,
                                 "trace": {"trace_id": trace, "public_key": KEY, "release": RELEASE, "sampled": "true", "sample_rate": "1"}},
                                ("transaction", tx)))
        time.sleep(0.2)
    time.sleep(2)  # the app goes to the background a moment after the last request
    t1 = time.time()
    session.update({"init": False, "status": "exited", "timestamp": rfc3339(t1),
                    "duration": round(t1 - t0, 3)})
    send(a.bridge, envelope({"sdk": SDK}, ("session", session)))
    end = int(time.time()) + 2
    json.dump({"start": start, "end": end, "backend": a.backend, "requests": a.requests, "session": sid}, open(a.out, "w"))
    print(f"sent {a.requests} requests in session {sid}; wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
