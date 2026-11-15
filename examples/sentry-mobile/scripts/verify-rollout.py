#!/usr/bin/env python3
"""Check that one rollout cohort's data landed where it should (ROLLOUT.md).

Run after scripts/rollout-journey.sh, with the window it printed:

  scripts/verify-rollout.py --mode parallel --start 2026-10-17T12:30:00Z --end 2026-10-17T12:31:30Z \
      --sentry-capture <sentrytap dir standing in for sentry.io> \
      [--loki http://localhost:3111] [--tempo http://localhost:3211]

What each cohort must produce inside the window:

  Sentry (the sentrytap capture behind the bridge upstream and the direct DSN)
    sentry    envelopes, every event and transaction tagged ouo.rum.mode=sentry, forwarded by
              the bridge (X-Forwarded-For set)
    parallel  envelopes tagged ouo.rum.mode=parallel, sent directly (no X-Forwarded-For)
    ouo       nothing at all
  ouo (Loki, Tempo)
    sentry    records and spans only from the bridge (service sentry-demo), all ouo.rum.mode=sentry
    parallel  records and spans only from the ouo SDK (service sentry-demo-ouo), all
              ouo.rum.mode=parallel; no bridge data (no double counting)
    ouo       records and spans only from the ouo SDK, all ouo.rum.mode=ouo;
              the unhandled rejection recorded by ouo

Exit 0 when every check passes. Standard library only.
"""
import argparse, collections, gzip, json, os, sys, urllib.parse, urllib.request, zlib
from datetime import datetime

BRIDGE_SERVICE = "sentry-demo"
OUO_SERVICE = "sentry-demo-ouo"
checks = []


def check(name, ok, detail=""):
    checks.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def epoch(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def get(url, token=None):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def envelopes(capdir, t0, t1):
    """(request headers, envelope header, [(type, payload)]) for requests inside the window."""
    if not capdir or not os.path.isdir(capdir):
        return
    for n in sorted(os.listdir(capdir)):
        p = os.path.join(capdir, n, "request.json")
        if not os.path.exists(p):
            continue
        req = json.load(open(p))
        when = req.get("time") or req.get("received_at")
        if when and not (t0 <= epoch(when) <= t1):
            continue
        body = open(os.path.join(capdir, n, "body.bin"), "rb").read()
        enc = (req["header"].get("Content-Encoding") or [""])[0]
        body = gzip.decompress(body) if enc == "gzip" else zlib.decompress(body) if enc == "deflate" else body
        head, _, rest = body.partition(b"\n")
        items = []
        while rest:
            if rest[:1] == b"\n":
                rest = rest[1:]
                continue
            h, _, rest = rest.partition(b"\n")
            hdr = json.loads(h)
            if "length" in hdr:
                pl, rest = rest[: hdr["length"]], rest[hdr["length"]:]
            else:
                pl, _, rest = rest.partition(b"\n")
            items.append((hdr.get("type"), pl))
        yield req["header"], json.loads(head or b"{}"), items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["sentry", "parallel", "ouo"])
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--sentry-capture", required=True)
    ap.add_argument("--loki", default="http://localhost:3111")
    ap.add_argument("--tempo", default="http://localhost:3211")
    a = ap.parse_args()
    m = a.mode
    t0, t1 = epoch(a.start) - 2, epoch(a.end) + 2
    print(f"== cohort {m}, {a.start} .. {a.end}")

    # ---- Sentry side -----------------------------------------------------------------------
    n_env, types, tags, forwarded = 0, collections.Counter(), collections.Counter(), collections.Counter()
    for h, _, items in envelopes(a.sentry_capture, t0, t1):
        n_env += 1
        forwarded["bridge" if h.get("X-Forwarded-For") else "direct"] += 1
        for typ, pl in items:
            types[typ] += 1
            if typ in ("event", "transaction"):
                tags[(json.loads(pl).get("tags") or {}).get("ouo.rum.mode", "(none)")] += 1
    detail = f"{n_env} envelopes, items {dict(types)}, ouo.rum.mode tags {dict(tags)}, {dict(forwarded)}"
    if m == "ouo":
        check("Sentry received nothing (Sentry was never initialised)", n_env == 0, detail)
    else:
        check("Sentry received the cohort's envelopes", n_env > 0 and types["event"] > 0 and types["transaction"] > 0, detail)
        check(f"every Sentry event and transaction is tagged ouo.rum.mode={m}", tags and set(tags) == {m}, detail)
        want = "bridge" if m == "sentry" else "direct"
        check(f"Sentry traffic went {'through the ouo bridge' if want == 'bridge' else 'straight to Sentry, not through the bridge'}",
              forwarded[want] == n_env, detail)
        if m == "sentry":
            check("Sentry recorded a replay", types["replay_video"] > 0, detail)

    # ---- ouo: Loki -------------------------------------------------------------------------
    def loki(query):
        r = get(f"{a.loki}/loki/api/v1/query_range?" + urllib.parse.urlencode(
            {"query": query, "start": int(t0 * 1e9), "end": int(t1 * 1e9 + 60e9), "limit": 5000}))
        return [(st["stream"], v) for st in r["data"]["result"] for v in st["values"] if t0 <= float(v[0]) / 1e9 <= t1]

    recs = loki('{service_name=~"%s|%s"}' % (BRIDGE_SERVICE, OUO_SERVICE))
    by = collections.Counter((s.get("service_name"), s.get("ouo_rum_mode", "(none)")) for s, _ in recs)
    names = collections.Counter(s.get("event_name") for s, _ in recs)
    detail = ", ".join(f"{svc}/{mode} {n}" for (svc, mode), n in sorted(by.items()))
    svc = BRIDGE_SERVICE if m == "sentry" else OUO_SERVICE
    check("ouo received the cohort's records", by[(svc, m)] > 0, detail)
    check(f"every ouo record of the window is {svc} with ouo.rum.mode={m} (no other cohort, no double counting)",
          set(by) == {(svc, m)}, detail)
    print(f"     event names: {dict(names)}")
    check("session.start recorded", names["session.start"] >= 1)
    exc = [s for s, _ in recs if s.get("event_name") == "exception" and s.get("ouo_sentry_synthetic") != "true"]
    # Handled error + unhandled rejection. Through the bridge also the info message: Sentry RN
    # 8.30 attaches its stack as `exception.values`, and the bridge maps any event with
    # exception values to an `exception` record (spec section 6).
    want_exc = 3 if m == "sentry" else 2
    check(f"{want_exc} exception records (handled error, unhandled rejection{', info message' if m == 'sentry' else ''})",
          len(exc) == want_exc, f"{len(exc)}")
    if m != "sentry":
        check("the info message is an ouo custom event", names["app.message"] == 1, f"{names['app.message']}")

    # ---- ouo: Tempo ------------------------------------------------------------------------
    def traceql(q):
        r = get(f"{a.tempo}/api/search?" + urllib.parse.urlencode({"q": q, "start": int(t0), "end": int(t1 + 60), "limit": 200}))
        return r.get("traces", [])

    mine = traceql('{ resource.ouo.rum.mode = "%s" && resource.service.name = "%s" }' % (m, svc))
    other = traceql('{ resource.service.name =~ "%s|%s" && resource.ouo.rum.mode != "%s" }' % (BRIDGE_SERVICE, OUO_SERVICE, m))
    check(f"Tempo has {svc} spans with ouo.rum.mode={m}", len(mine) > 0, f"{len(mine)} traces")
    check("Tempo has no app spans of another cohort in the window", len(other) == 0, f"{len(other)} traces")

    print(f"{sum(checks)}/{len(checks)} checks passed")
    sys.exit(0 if all(checks) else 1)


if __name__ == "__main__":
    main()
