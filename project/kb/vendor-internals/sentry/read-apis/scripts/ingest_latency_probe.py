#!/usr/bin/env python3
"""Measure how long Sentry takes to make freshly ingested data visible in its read APIs.

Sends ONE envelope set (error event, transaction with spans, log, release-health session,
and a two-segment rrweb replay) through the project DSN, then polls each read endpoint until
the data shows up. Prints a JSON report.

Stdlib only. Usage:
  SENTRY_URL=http://localhost:9000 SENTRY_TOKEN=<read token> \
  SENTRY_PROBE_DSN=http://<public_key>@localhost:9000/<project_id> \
  SENTRY_ORG=sentry SENTRY_PROJECT=<project slug> python3 -I ingest_latency_probe.py

It writes data into the project (that is the point). Use a throwaway project or environment.
"""
import json, os, time, uuid, urllib.request, urllib.error, urllib.parse, zlib

URL = os.environ.get("SENTRY_URL", "http://localhost:9000").rstrip("/")
TOKEN = os.environ["SENTRY_TOKEN"]
DSN = urllib.parse.urlparse(os.environ["SENTRY_PROBE_DSN"])
ORG = os.environ.get("SENTRY_ORG", "sentry")
PROJECT = os.environ["SENTRY_PROJECT"]
ENV = os.environ.get("SENTRY_PROBE_ENV", "read-api-probe")
RELEASE = os.environ.get("SENTRY_PROBE_RELEASE", "read-api-probe@1.0.0")
KEY, PROJECT_ID = DSN.username, DSN.path.strip("/")
INGEST = f"{DSN.scheme}://{DSN.hostname}:{DSN.port or 80}/api/{PROJECT_ID}/envelope/"
TIMEOUT_S = float(os.environ.get("SENTRY_PROBE_TIMEOUT", "300"))


def now_iso(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t or time.time())) + "Z"


def send(items, header):
    body = (json.dumps(header) + "\n").encode()
    for h, payload in items:
        if not isinstance(payload, bytes):
            payload = json.dumps(payload).encode()
        h = dict(h, length=len(payload))
        body += json.dumps(h).encode() + b"\n" + payload + b"\n"
    req = urllib.request.Request(INGEST, data=body, method="POST", headers={
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": f"Sentry sentry_version=7, sentry_key={KEY}, sentry_client=ouo-read-api-probe/0.1",
    })
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, r.read().decode()


def get(path):
    req = urllib.request.Request(URL + path, headers={"Authorization": "Bearer " + TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200]


def main():
    t0 = time.time()
    event_id, trace_id, replay_id = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
    txn_id, span_root, span_child = uuid.uuid4().hex, uuid.uuid4().hex[:16], uuid.uuid4().hex[:16]
    sid = str(uuid.uuid4())
    sdk = {"name": "ouo.read-api-probe", "version": "0.1.0"}
    ms = int(t0 * 1000)

    error = {
        "event_id": event_id, "timestamp": t0, "platform": "javascript", "level": "error",
        "environment": ENV, "release": RELEASE, "sdk": sdk,
        "exception": {"values": [{"type": "ProbeError", "value": f"read-api latency probe {event_id[:8]}"}]},
        "user": {"id": "probe-user-1"},
        "tags": {"replayId": replay_id},
        "contexts": {"trace": {"trace_id": trace_id, "span_id": span_root},
                     "replay": {"replay_id": replay_id}},
    }
    txn = {
        "event_id": txn_id, "type": "transaction", "transaction": "/probe", "platform": "javascript",
        "start_timestamp": t0 - 1.0, "timestamp": t0, "environment": ENV, "release": RELEASE, "sdk": sdk,
        "contexts": {"trace": {"trace_id": trace_id, "span_id": span_root, "op": "pageload", "status": "ok"},
                     "replay": {"replay_id": replay_id}},
        "spans": [{"trace_id": trace_id, "span_id": span_child, "parent_span_id": span_root, "op": "http.client",
                   "description": "GET /probe-api", "start_timestamp": t0 - 0.8, "timestamp": t0 - 0.2, "status": "ok"}],
    }
    log = {"items": [{"timestamp": t0, "trace_id": trace_id, "level": "info", "body": f"probe log {event_id[:8]}",
                      "attributes": {"sentry.environment": {"value": ENV, "type": "string"},
                                     "sentry.release": {"value": RELEASE, "type": "string"}}}]}
    session = {"sid": sid, "did": "probe-user-1", "init": True, "started": now_iso(t0 - 5), "timestamp": now_iso(t0),
               "status": "exited", "errors": 1, "duration": 5.0, "attrs": {"release": RELEASE, "environment": ENV}}

    def replay_items(seg, events, ts):
        replay_event = {"type": "replay_event", "replay_id": replay_id, "event_id": replay_id, "segment_id": seg,
                        "replay_type": "session", "timestamp": ts, "replay_start_timestamp": t0 - 1.0,
                        "urls": ["http://probe.local/"] if seg == 0 else [], "error_ids": [event_id] if seg == 0 else [],
                        "trace_ids": [trace_id] if seg == 0 else [], "platform": "javascript", "environment": ENV,
                        "release": RELEASE, "sdk": sdk, "user": {"id": "probe-user-1"},
                        "contexts": {"replay": {"session_sample_rate": 1, "error_sample_rate": 0}}}
        rec = b'{"segment_id":%d}\n' % seg + zlib.compress(json.dumps(events).encode())
        return [({"type": "replay_event"}, replay_event), ({"type": "replay_recording"}, rec)]

    seg0 = [{"type": 4, "timestamp": ms - 1000, "data": {"href": "http://probe.local/", "width": 800, "height": 600}},
            {"type": 2, "timestamp": ms - 1000, "data": {"node": {"type": 0, "id": 1, "childNodes": []},
                                                         "initialOffset": {"left": 0, "top": 0}}}]
    seg1 = [{"type": 3, "timestamp": ms, "data": {"source": 1, "positions": [{"x": 1, "y": 2, "id": 1, "timeOffset": 0}]}}]

    hdr = {"sent_at": now_iso(), "sdk": sdk}
    sends = {
        "error": send([({"type": "event"}, error)], dict(hdr, event_id=event_id)),
        "transaction": send([({"type": "transaction"}, txn)], dict(hdr, event_id=txn_id, trace={"trace_id": trace_id, "public_key": KEY})),
        "log": send([({"type": "log", "item_count": 1, "content_type": "application/vnd.sentry.items.log+json"}, log)], hdr),
        "session": send([({"type": "session"}, session)], hdr),
        "replay_seg0": send(replay_items(0, seg0, t0 - 1.0), dict(hdr, event_id=replay_id)),
        "replay_seg1": send(replay_items(1, seg1, t0), dict(hdr, event_id=replay_id)),
    }
    t_sent = time.time()

    q = urllib.parse.quote
    w = f"statsPeriod=1h&project={PROJECT_ID}"
    checks = {
        "eventid_lookup": (f"/api/0/organizations/{ORG}/eventids/{event_id}/", lambda s, b: s == 200),
        "project_event_details": (f"/api/0/projects/{ORG}/{PROJECT}/events/{event_id}/", lambda s, b: s == 200),
        "discover_errors": (f"/api/0/organizations/{ORG}/events/?dataset=errors&field=id&{w}&query={q('id:' + event_id)}",
                            lambda s, b: s == 200 and len(b.get("data", [])) == 1),
        "discover_transactions": (f"/api/0/organizations/{ORG}/events/?dataset=transactions&field=id&{w}&query={q('id:' + txn_id)}",
                                  lambda s, b: s == 200 and len(b.get("data", [])) == 1),
        "spans_dataset": (f"/api/0/organizations/{ORG}/events/?dataset=spans&field=id&{w}&query={q('trace:' + trace_id)}",
                          lambda s, b: s == 200 and len(b.get("data", [])) >= 2),
        "logs_dataset": (f"/api/0/organizations/{ORG}/events/?dataset=ourlogs&field=message&{w}&query={q('trace:' + trace_id)}",
                         lambda s, b: s == 200 and len(b.get("data", [])) >= 1),
        "trace_endpoint": (f"/api/0/organizations/{ORG}/trace/{trace_id}/?{w}",
                           lambda s, b: s == 200 and isinstance(b, list) and len(b) >= 1),
        "replay_list": (f"/api/0/organizations/{ORG}/replays/?{w}&field=id&field=count_segments&query={q('id:' + replay_id)}",
                        lambda s, b: s == 200 and len(b.get("data", [])) == 1),
        "replay_list_both_segments": (f"/api/0/organizations/{ORG}/replays/?{w}&field=id&field=count_segments&query={q('id:' + replay_id)}",
                                      lambda s, b: s == 200 and b.get("data") and b["data"][0]["count_segments"] == 2),
        "replay_details": (f"/api/0/organizations/{ORG}/replays/{replay_id}/", lambda s, b: s == 200),
        "replay_segments_both": (f"/api/0/projects/{ORG}/{PROJECT}/replays/{replay_id}/recording-segments/",
                                 lambda s, b: s == 200 and isinstance(b, list) and len(b) == 2 and all(b)),
        "replay_by_error_id": (f"/api/0/organizations/{ORG}/replays/?{w}&field=id&query={q('error_ids:' + event_id)}",
                               lambda s, b: s == 200 and len(b.get("data", [])) == 1),
        "sessions": (f"/api/0/organizations/{ORG}/sessions/?field=sum(session)&{w}&interval=1h&environment={q(ENV)}&query={q('release:' + RELEASE)}",
                     lambda s, b: s == 200 and any(g["totals"].get("sum(session)", 0) > 0 for g in b.get("groups", []))),
    }
    seen, polls = {}, 0
    while len(seen) < len(checks) and time.time() - t_sent < TIMEOUT_S:
        polls += 1
        for name, (path, ok) in checks.items():
            if name in seen:
                continue
            s, b = get(path)
            if ok(s, b):
                seen[name] = round(time.time() - t_sent, 2)
        time.sleep(0.5)
    print(json.dumps({
        "sent_at": now_iso(t0), "ids": {"event_id": event_id, "trace_id": trace_id, "replay_id": replay_id,
                                        "transaction_id": txn_id, "session_id": sid},
        "ingest_status": {k: v[0] for k, v in sends.items()},
        "seconds_until_visible": seen, "never_visible": sorted(set(checks) - set(seen)),
        "polls": polls, "timeout_s": TIMEOUT_S,
    }, indent=2))


if __name__ == "__main__":
    main()
