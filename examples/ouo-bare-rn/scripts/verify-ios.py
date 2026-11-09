#!/usr/bin/env python3
"""Checks the launches of scripts/verify-ios.sh (the bare React Native 0.82 app on the iOS Simulator)
against rum-api, with the capability ids of docs/specs/mobile-sdk.md where one applies:

  journey  ../ouo-mobile/scripts/verify.py --vitals --feedback (traces, sessions, failed requests,
           vitals C4, feedback C10), then session replay recorded on the device (C8.1)
  crash    a native crash (SIGSEGV) reported by the next launch: session crashed, kind native (C2.2)
  hang     one non-fatal hang of >= 2 s (C3.1)
  oom      a fatal termination after a memory warning, reported by the next launch (C3.2)
  gzip     every OTLP request the proxy saw was gzip-encoded natively (C11.2)

Env: the variables of `deploy/envs/ouo-env env <env>` (OUO_RUM_API_URL, OUO_READ_TOKEN, OUO_TEMPO_URL, OUO_LOKI_URL).
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../tools"))
import rumcheck  # noqa: E402

SERVICE = "mobile-store"  # the golden app's initRUM (../ouo-mobile/src/rum.ts)


def attr(e, key):
    return (e.get("attrs") or {}).get(key.replace(".", "_"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phases", required=True)
    ap.add_argument("--requests", required=True)
    ap.add_argument("--backend", required=True)
    ap.add_argument("--device", required=True)
    a = ap.parse_args()
    rum = os.environ.get("OUO_RUM_API_URL", "http://localhost:8080")
    token = os.environ.get("OUO_READ_TOKEN", "rt_dev_0000000000000000")
    phases = json.load(open(a.phases))
    results = []

    def add(name, ok, detail=""):
        results.append((name, ok))
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)

    # journey: the golden app's own verification, unchanged.
    j0, j1 = phases["journey"]
    jfile = os.path.join(os.path.dirname(a.phases), "journey.json")
    json.dump({"start": j0, "end": j1, "backend": a.backend, "device": a.device}, open(jfile, "w"))
    rc = subprocess.call([sys.executable, "-I", os.path.join(HERE, "../../ouo-mobile/scripts/verify.py"), "--journey", jfile, "--vitals", "--feedback"])
    add("journey: ouo-mobile verify.py --vitals --feedback", rc == 0, f"exit {rc}")

    def details(phase):
        t0, t1 = phases[phase]
        ss = rumcheck.sessions(rum, token, SERVICE, t0, t1)
        inside = [s for s in ss if t0 * 1000 <= rumcheck.epoch_ms(s["started_at"]) <= t1 * 1000]
        return [rumcheck.get(rum, f"/v1/sessions/{s['session_id']}", token) for s in inside]

    def exceptions(ds, kind):
        return [(d, e) for d in ds for e in d.get("timeline", []) if e.get("name") == "exception" and attr(e, "ouo.exception.kind") == kind]

    js = details("journey")
    replayed = [d for d in js if d.get("has_replay")]
    frames = 0
    if replayed:
        frames = len(rumcheck.get(rum, f"/v1/sessions/{replayed[0]['session_id']}/replay/frames", token).get("frames", []))
    add("C8.1 replay: the journey's session has frames", frames > 0, f"{len(replayed)}/{len(js)} sessions with replay, {frames} frames")

    # Native signals are exported by the launch after the event: give ingestion a moment.
    time.sleep(5)
    native = exceptions(details("crash"), "native")
    crashed = [d for d, e in native if d.get("status") == "crashed" and d.get("end_reason") == "crash" and attr(e, "ouo.exception.fatal") == "true"]
    add("C2.2 native crash (SIGSEGV) reported by the next launch, session crashed", len(crashed) == 1,
        "; ".join(f"{attr(e, 'exception.type')} {attr(e, 'exception.message')}" for _, e in native)[:200])

    hangs = exceptions(details("hang"), "hang")
    add("C3.1 one non-fatal hang >= 2 s", len(hangs) == 1 and float(attr(hangs[0][1], "ouo.hang.duration_ms") or 0) >= 2000
        and attr(hangs[0][1], "ouo.exception.fatal") == "false",
        ", ".join(str(attr(e, "ouo.hang.duration_ms")) for _, e in hangs))

    terms = exceptions(details("oom"), "termination")
    add("C3.2 fatal termination after a memory warning", any(attr(e, "ouo.exception.fatal") == "true" and d.get("status") == "crashed" for d, e in terms),
        ", ".join(f"cause {attr(e, 'ouo.termination.cause')}" for _, e in terms))

    reqs = [json.loads(l) for l in open(a.requests) if l.strip()]
    otlp = [r for r in reqs if r.get("path") in ("/v1/logs", "/v1/traces")]
    gz = [r for r in otlp if r.get("encoding") == "gzip"]
    add("C11.2 OTLP requests gzip-encoded on the device", bool(otlp) and len(gz) == len(otlp), f"{len(gz)}/{len(otlp)} gzip")

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
