#!/usr/bin/env python3
"""Verify the Sentry bridge end to end against what the SDK really sent (ADR-0008).

Reads a sentrytap capture taken in front of the bridge (what the SDK sent), derives the
expected sessions, errors and replays from the raw envelopes on its own, and compares them
with what Loki and Tempo hold. The bridge drops Sentry video replay (no ouo replay store for it).

  scripts/verify-bridge.py --capture <dir A> [--loki http://localhost:3103]
                           [--tempo http://localhost:3203] [--service sentry-demo]
                           [--out report.json]

Exit 0 when every check passes. Standard library only.
"""
import argparse
import collections, gzip, hashlib, json, os, struct, subprocess, sys, tempfile, time, urllib.parse, urllib.request, zlib
from datetime import datetime, timezone

checks = []


def check(name, ok, detail=""):
    checks.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def ts(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()


def envelopes(capdir):
    for n in sorted(os.listdir(capdir)):
        req = json.load(open(os.path.join(capdir, n, "request.json")))
        body = open(os.path.join(capdir, n, "body.bin"), "rb").read()
        enc = (req["header"].get("Content-Encoding") or [""])[0]
        if enc == "gzip":
            body = gzip.decompress(body)
        elif enc == "deflate":
            body = zlib.decompress(body)
        yield parse(body)


def parse(b):
    line, _, rest = b.partition(b"\n")
    items = []
    while rest:
        if rest[:1] == b"\n":
            rest = rest[1:]
            continue
        h, _, rest = rest.partition(b"\n")
        hdr = json.loads(h)
        if "length" in hdr:
            p, rest = rest[: hdr["length"]], rest[hdr["length"]:]
            rest = rest[1:] if rest[:1] == b"\n" else rest
        else:
            p, _, rest = rest.partition(b"\n")
        items.append((hdr["type"], p))
    return json.loads(line), items


def msgpack_map(b):
    pos = 0

    def take(n):
        nonlocal pos
        v = b[pos:pos + n]
        pos += n
        return v

    t = take(1)[0]
    n = t & 0x0F if 0x80 <= t <= 0x8F else struct.unpack(">H" if t == 0xDE else ">I", take(2 if t == 0xDE else 4))[0]
    out = {}
    for _ in range(n):
        kv = []
        for _ in range(2):
            c = take(1)[0]
            if 0xA0 <= c <= 0xBF:
                ln = c & 0x1F
            else:
                ln = struct.unpack({0xD9: ">B", 0xC4: ">B", 0xDA: ">H", 0xC5: ">H", 0xDB: ">I", 0xC6: ">I"}[c],
                                   take({0xD9: 1, 0xC4: 1, 0xDA: 2, 0xC5: 2, 0xDB: 4, 0xC6: 4}[c]))[0]
            kv.append(take(ln))
        out[kv[0].decode()] = kv[1]
    return out


def get(url, token=None, raw=False):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
        return data if raw else json.loads(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", required=True)
    ap.add_argument("--loki", default="http://localhost:3103")
    ap.add_argument("--tempo", default="http://localhost:3203")
    ap.add_argument("--service", default="sentry-demo")
    ap.add_argument("--backend-service", default="demo-backend")
    ap.add_argument("--out")
    a = ap.parse_args()

    # ---- ground truth from the raw envelopes ------------------------------------------
    sessions = {}      # sid -> {started, statuses, errors}
    errors = []        # (time, fatal) of events with exceptions or level error/fatal
    replays = {}       # replay_id -> list of (segment_id, start_ms, mp4 size)
    tx_traces = set()
    backend_traces = set()  # transactions with an http.client span to the backend (traceparent sent)
    logs = []               # Sentry log entries
    crumbs = {"http.request": 0}  # replay breadcrumbs the bridge turns into records
    console_crumbs = []           # (time, message) of console breadcrumbs
    for hdr, items in envelopes(a.capture):
        for typ, p in items:
            if typ == "session":
                s = json.loads(p)
                e = sessions.setdefault(s["sid"], {"started": ts(s["started"]), "statuses": [], "errors": 0, "init": False})
                e["statuses"].append(s.get("status", "ok"))
                e["errors"] = max(e["errors"], s.get("errors", 0))
                e["init"] |= bool(s.get("init"))
            elif typ == "event":
                ev = json.loads(p)
                if (ev.get("exception") or {}).get("values") or ev.get("level") in ("error", "fatal"):
                    errors.append((ts(ev.get("timestamp")), ev.get("level") == "fatal"))
            elif typ == "transaction":
                tx = json.loads(p)
                tid = tx["contexts"]["trace"]["trace_id"]
                tx_traces.add(tid)
                if any(sp.get("op", "").startswith("http.client") and "/api/" in (sp.get("description") or "") for sp in tx.get("spans", [])):
                    backend_traces.add(tid)
            elif typ == "log":
                logs.extend(json.loads(p).get("items", []))
            elif typ == "replay_video":
                m = msgpack_map(p)
                rev = json.loads(m["replay_event"])
                rec = m.get("replay_recording", b"")
                rec_events = json.loads(rec.partition(b"\n")[2] or b"[]")
                for e in rec_events:
                    if e.get("type") != 5 or e["data"].get("tag") != "breadcrumb":
                        continue
                    bc = e["data"].get("payload", {})
                    code = (bc.get("data") or {}).get("status_code") or 0
                    if bc.get("category") in ("fetch", "xhr", "http") and 0 < code < 500:
                        crumbs["http.request"] += 1
                    elif bc.get("category") == "console":
                        console_crumbs.append((e["timestamp"] / 1000, bc.get("message", "")))
                start = next((e["timestamp"] for e in rec_events if e.get("type") == 5 and e["data"].get("tag") == "video"), None)
                replays.setdefault(rev["replay_id"], []).append((rev["segment_id"], start, hashlib.sha256(m.get("replay_video", b"")).hexdigest()))
    started = [s for s in sessions.values() if s["init"]]
    t0 = min(s["started"] for s in started) - 60
    t1 = time.time()
    print(f"capture: {len(sessions)} sessions ({len(started)} started here), {len(errors)} error events, "
          f"{len(tx_traces)} transactions ({len(backend_traces)} calling the backend), {len(logs)} log entries, "
          f"{len(replays)} replays / {sum(len(v) for v in replays.values())} segments")

    # ---- errors in Loki -------------------------------------------------------------------
    lq = '{service_name="%s", event_name="exception"}' % a.service
    lr = get(f"{a.loki}/loki/api/v1/query_range?" + urllib.parse.urlencode(
        {"query": lq, "start": int(t0 * 1e9), "end": int((t1 + 60) * 1e9), "limit": 5000}))
    loki_exc = [v for st in lr["data"]["result"] for v in st["values"]
                if st["stream"].get("ouo_sentry_synthetic") != "true" and float(v[0]) / 1e9 >= min(e[0] for e in errors) - 1]
    loki_fatal = [v for st in lr["data"]["result"] for v in st["values"] if st["stream"].get("ouo_exception_fatal") == "true"]
    check("every Sentry error event is an exception record in Loki", len(loki_exc) == len(errors), f"{len(loki_exc)} in Loki, {len(errors)} sent")
    check("fatal events are fatal in Loki", len(loki_fatal) == sum(1 for e in errors if e[1]), f"{len(loki_fatal)} fatal")

    # ---- logs and breadcrumbs in Loki -------------------------------------------------------
    def loki_values(event_name):
        q = '{service_name="%s", event_name="%s"}' % (a.service, event_name)
        r = get(f"{a.loki}/loki/api/v1/query_range?" + urllib.parse.urlencode(
            {"query": q, "start": int(t0 * 1e9), "end": int((t1 + 60) * 1e9), "limit": 5000}))
        return [(st["stream"], v) for st in r["data"]["result"] for v in st["values"]]

    # Console output arrives twice with enableLogs (a log entry and a replay breadcrumb); the bridge
    # keeps one `console` record per line (same message within 2 s).
    is_console = lambda l: (l.get("attributes", {}).get("sentry.origin") or {}).get("value") == "auto.log.console"
    console_logs = [(l["timestamp"], l["body"]) for l in logs if is_console(l)]
    app_logs = [l for l in logs if not is_console(l)]
    lines = []
    for t_, m in sorted(console_logs + console_crumbs):
        if not any(m == m2 and abs(t_ - t2) <= 2 for t2, m2 in lines):
            lines.append((t_, m))
    loki_console = loki_values("console")
    check("console output is one `console` record per line (log entries and breadcrumbs de-duplicated)", len(loki_console) == len(lines),
          f"{len(loki_console)} in Loki, {len(console_logs)} console log entries + {len(console_crumbs)} breadcrumbs = {len(lines)} lines")
    if logs:
        loki_logs = loki_values("log")
        check("every Sentry.logger entry is a `log` record in Loki", len(loki_logs) == len(app_logs), f"{len(loki_logs)} in Loki, {len(app_logs)} sent")
        both = loki_logs + loki_console
        with_sid = [x for x in both if x[0].get("session_id")]
        check("every log and console record has a session", len(with_sid) == len(both),
              f"{len(with_sid)}/{len(both)}; matches: " + ", ".join(f"{k} {v}" for k, v in sorted(collections.Counter(x[0].get('ouo_sentry_session_match', '?') for x in both).items())))
        known = {sid for sid in sessions}
        check("log records are in sessions of this capture", all(x[0].get("session_id") in known for x in with_sid))
    for name, want in crumbs.items():
        got_n = len(loki_values(name))
        check(f"every replay breadcrumb of kind {name} is a record in Loki", got_n == want, f"{got_n} in Loki, {want} in the recordings")

    # ---- traces in Tempo ---------------------------------------------------------------------
    found, joined = 0, 0
    for tid in tx_traces:
        try:
            tr = get(f"{a.tempo}/api/v2/traces/{tid}")
        except Exception:
            continue
        app_spans, backend_spans = [], []
        for b in tr.get("trace", {}).get("resourceSpans", []):
            svc = next((x["value"].get("stringValue") for x in b.get("resource", {}).get("attributes", []) if x["key"] == "service.name"), "")
            spans = [s for ss in b.get("scopeSpans", []) for s in ss.get("spans", [])]
            (app_spans if svc == a.service else backend_spans if svc == a.backend_service else []).extend(spans)
        if app_spans and all(any(x["key"] == "session.id" for x in s.get("attributes", [])) for s in app_spans):
            found += 1
        if tid in backend_traces and backend_spans:
            # The backend's server span hangs off one of the app's http.client spans.
            app_ids = {s["spanId"] for s in app_spans}
            if any(s.get("parentSpanId") in app_ids for s in backend_spans):
                joined += 1
    check("every Sentry transaction is a trace in Tempo with session.id on all app spans", found == len(tx_traces), f"{found}/{len(tx_traces)}")
    if backend_traces:
        check("every transaction that called the backend is one trace with the backend's spans (traceparent)",
              joined == len(backend_traces), f"{joined}/{len(backend_traces)}")

    failed = [c for c in checks if not c["ok"]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    if a.out:
        json.dump({"capture": a.capture, "checks": checks, "at": datetime.now(timezone.utc).isoformat()}, open(a.out, "w"), indent=2)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
