"""Send hand-crafted Sentry envelopes to self-hosted Relay and record the answers.

Usage: venv/bin/python -I harness.py <out_dir> <public_key> [case ...]
Writes <out_dir>/<case>.json with the request summary (key redacted) and the response.
"""
import gzip, http.client, json, os, struct, sys, time, uuid, zlib
import compression.zstd as zstd
import brotli

OUT, KEY = sys.argv[1], sys.argv[2]
ONLY = set(sys.argv[3:])
HOST, PORT, PID = "localhost", 9000, 8
RED = "<redacted-public-key>"
os.makedirs(OUT, exist_ok=True)
STATE = {}


def hexid():
    return uuid.uuid4().hex


def now():
    return time.time()


def iso(t=None):
    t = now() if t is None else t
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


def auth(version=7):
    return f"Sentry sentry_key={KEY}, sentry_version={version}, sentry_client=step6.wire/0.0.1"


def env_header(eid=None, **extra):
    h = {"sent_at": iso(), "dsn": f"http://{KEY}@localhost:9000/{PID}", "sdk": {"name": "step6.wire", "version": "0.0.1"}}
    if eid:
        h["event_id"] = eid
    h.update(extra)
    return h


def item(header, payload, length=True):
    if isinstance(payload, (dict, list)):
        payload = json.dumps(payload, separators=(",", ":")).encode()
    if length:
        header = dict(header, length=len(payload))
    return json.dumps(header, separators=(",", ":")).encode() + b"\n" + payload + b"\n"


def envelope(header, *items):
    return json.dumps(header, separators=(",", ":")).encode() + b"\n" + b"".join(items)


def redact(s):
    if isinstance(s, bytes):
        s = s.decode("utf-8", "replace")
    return s.replace(KEY, RED)


def send(case, path, body, headers=None, method="POST", note=""):
    if ONLY and case not in ONLY:
        return None
    headers = dict(headers or {})
    conn = http.client.HTTPConnection(HOST, PORT, timeout=120)
    t0 = time.time()
    conn.request(method, path, body=body, headers=headers)
    r = conn.getresponse()
    data = r.read()
    dt = (time.time() - t0) * 1000
    keep = {}
    for k, v in r.getheaders():
        if k.lower() in ("content-type", "x-sentry-rate-limits", "retry-after", "x-sentry-error", "access-control-allow-origin", "access-control-expose-headers", "access-control-allow-headers", "access-control-allow-methods", "server"):
            keep[k] = v
    preview = body[:600] if isinstance(body, bytes) else (body or b"")
    rec = {
        "case": case,
        "note": note,
        "observed": "self-hosted Sentry 26.10.0 (Relay 26.10.0) via nginx at localhost:9000, " + iso(),
        "request": {
            "method": method,
            "path": redact(path),
            "headers": {k: redact(v) for k, v in headers.items()},
            "body_bytes": len(body or b""),
            "body_preview": redact(preview) if all(32 <= c < 127 or c in (9, 10, 13) for c in preview[:200]) else f"<binary, first bytes {preview[:16].hex()}>",
        },
        "response": {"status": r.status, "headers": keep, "body": redact(data[:2000]), "ms": round(dt, 1)},
    }
    with open(os.path.join(OUT, case + ".json"), "w") as f:
        json.dump(rec, f, indent=2)
        f.write("\n")
    print(f"{case:40s} {r.status} {redact(data[:160])!r} {keep.get('X-Sentry-Rate-Limits') or keep.get('x-sentry-rate-limits') or ''}")
    return rec


EP = f"/api/{PID}/envelope/"
H = {"X-Sentry-Auth": auth(), "Content-Type": "application/x-sentry-envelope"}


def error_env(msg="step6-wire error", eid=None):
    eid = eid or hexid()
    ev = {"event_id": eid, "message": msg, "level": "error", "platform": "javascript", "timestamp": now(),
          "release": "step6-wire@1.0.0", "environment": "wire", "tags": {"step6": "wire"},
          "exception": {"values": [{"type": "TypeError", "value": msg, "mechanism": {"type": "onerror", "handled": False},
                                    "stacktrace": {"frames": [{"filename": "app.js", "function": "boom", "lineno": 10, "colno": 5, "in_app": True}]}}]}}
    return eid, envelope(env_header(eid), item({"type": "event", "content_type": "application/json"}, ev))


def main():
    # ---- framing, auth, compression ------------------------------------------------
    eid, body = error_env("step6-wire plain")
    STATE["error_event_id"] = eid
    send("event-plain", EP, body, H, note="error event, length header, X-Sentry-Auth")
    eid, body = error_env("step6-wire gzip")
    send("event-gzip", EP, gzip.compress(body), dict(H, **{"Content-Encoding": "gzip"}))
    eid, body = error_env("step6-wire deflate-zlib")
    send("event-deflate-zlib", EP, zlib.compress(body), dict(H, **{"Content-Encoding": "deflate"}), note="HTTP deflate = zlib wrapper (RFC 9110)")
    eid, body = error_env("step6-wire deflate-raw")
    co = zlib.compressobj(wbits=-15); raw = co.compress(body) + co.flush()
    send("event-deflate-raw", EP, raw, dict(H, **{"Content-Encoding": "deflate"}), note="raw deflate without zlib wrapper")
    eid, body = error_env("step6-wire br")
    send("event-br", EP, brotli.compress(body), dict(H, **{"Content-Encoding": "br"}))
    eid, body = error_env("step6-wire zstd")
    send("event-zstd", EP, zstd.compress(body), dict(H, **{"Content-Encoding": "zstd"}))
    eid, body = error_env("step6-wire bad gzip")
    send("event-gzip-header-plain-body", EP, body, dict(H, **{"Content-Encoding": "gzip"}), note="Content-Encoding gzip but body not compressed")
    eid, body = error_env("step6-wire x-gzip")
    send("event-x-gzip", EP, gzip.compress(body), dict(H, **{"Content-Encoding": "x-gzip"}))
    eid, body = error_env("step6-wire no length")
    nl = envelope(env_header(eid), item({"type": "event"}, {"event_id": eid, "message": "step6-wire no length", "timestamp": now()}, length=False))
    send("event-no-length", EP, nl, H, note="item without length: payload runs to next newline")
    send("event-no-trailing-newline", EP, nl.rstrip(b"\n"), H, note="envelope ends right after the payload")
    send("event-double-trailing-newline", EP, nl + b"\n", H, note="extra empty line at the end")
    eid, body = error_env("step6-wire blank line between")
    eh, rest = body.split(b"\n", 1)
    cr = env_header(None)
    two = envelope(env_header(eid), item({"type": "event"}, {"event_id": eid, "message": "x", "timestamp": now()}), b"\n",
                   item({"type": "client_report"}, {"timestamp": now(), "discarded_events": [{"reason": "queue_overflow", "category": "error", "quantity": 1}]}))
    send("blank-line-between-items", EP, two, H, note="an empty line between two items")
    send("event-length-too-long", EP, envelope(env_header(eid), b'{"type":"event","length":500}\n{"message":"short"}\n'), H)
    send("event-length-short-no-newline", EP, envelope(env_header(eid), b'{"type":"event","length":5}\n{"message":"short"}\n'), H, note="length shorter than payload: byte after payload is not a newline")
    send("header-only-no-items", EP, json.dumps(env_header(hexid())).encode() + b"\n", H, note="envelope header and no items")
    send("empty-body", EP, b"", H)
    send("malformed-header", EP, b"{not json}\n", H)
    send("item-header-not-json", EP, json.dumps(env_header()).encode() + b"\n{type:event}\n{}\n", H)
    send("crlf-line-endings", EP, envelope(env_header(eid), b'{"type":"event","length":13}\r\n{"message":1}\r\n'), H, note="CRLF after headers")

    # auth variants
    eid, body = error_env("step6-wire query auth")
    send("auth-query-sentry_key", EP + f"?sentry_key={KEY}&sentry_version=7", body, {"Content-Type": "application/x-sentry-envelope"})
    eid, body = error_env("step6-wire dsn auth")
    send("auth-envelope-dsn-only", EP, body, {"Content-Type": "text/plain;charset=UTF-8"}, note="no header/query auth: Relay reads dsn from the envelope header (browser tunnel / sendBeacon style)")
    send("auth-authorization-header", EP, error_env("step6-wire authorization")[1], {"Authorization": auth()}, note="Authorization: Sentry ... instead of X-Sentry-Auth")
    import base64
    send("auth-basic", EP, error_env("step6-wire basic")[1], {"Authorization": "Basic " + base64.b64encode(f"{KEY}:".encode()).decode()}, note="HTTP basic auth with public key as user")
    send("auth-header-and-query", EP + f"?sentry_key={KEY}", error_env("x")[1], H, note="X-Sentry-Auth and ?sentry_key together")
    noauth = envelope({"event_id": hexid()}, item({"type": "event"}, {"message": "no auth"}))
    send("auth-missing", EP, noauth, {"Content-Type": "application/x-sentry-envelope"})
    send("auth-bad-key-format", EP, noauth, {"X-Sentry-Auth": "Sentry sentry_key=nothex, sentry_version=7"})
    send("auth-unknown-key", EP, envelope({"event_id": hexid()}, item({"type": "event"}, {"message": "unknown key"})),
         {"X-Sentry-Auth": "Sentry sentry_key=0000000000000000000000000000beef, sentry_version=7"}, note="well-formed key that no project has")
    send("auth-version-8", EP, error_env("v8")[1], {"X-Sentry-Auth": auth(8)})
    send("auth-version-5", EP, error_env("step6-wire v5")[1], {"X-Sentry-Auth": auth(5)})
    send("auth-dsn-project-mismatch", EP, envelope(dict(env_header(hexid()), dsn=f"http://{KEY}@localhost:9000/999"), item({"type": "event"}, {"message": "x"})), H)
    send("auth-wrong-project-in-path", "/api/5/envelope/", error_env("step6-wire wrong project")[1], H, note="key of project 8 posted to /api/5/")
    send("cors-preflight", EP, b"", {"Origin": "http://example.invalid", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-sentry-auth"}, method="OPTIONS")

    # ---- item types --------------------------------------------------------------
    t = now()
    trace = hexid()
    root = hexid()[:16]
    txid = hexid()
    tx = {"type": "transaction", "event_id": txid, "transaction": "/step6/wire", "transaction_info": {"source": "route"}, "start_timestamp": t - 2, "timestamp": t,
          "platform": "javascript", "release": "step6-wire@1.0.0", "environment": "wire",
          "contexts": {"trace": {"trace_id": trace, "span_id": root, "op": "pageload", "status": "ok"}},
          "spans": [{"trace_id": trace, "span_id": hexid()[:16], "parent_span_id": root, "op": "http.client", "description": "GET /api", "start_timestamp": t - 1.5, "timestamp": t - 1}],
          "measurements": {"lcp": {"value": 1200, "unit": "millisecond"}}}
    dsc = {"trace_id": trace, "public_key": KEY, "sample_rate": "1", "sample_rand": "0.5", "sampled": "true", "transaction": "/step6/wire", "release": "step6-wire@1.0.0", "environment": "wire"}
    STATE["transaction_id"], STATE["trace_id"] = txid, trace
    send("item-transaction", EP, envelope(env_header(txid, trace=dsc), item({"type": "transaction"}, tx)), H)
    sid = str(uuid.uuid4())
    sess = {"sid": sid, "did": "step6-user", "init": True, "started": iso(t - 5), "timestamp": iso(t), "status": "exited", "errors": 1, "duration": 5.0,
            "attrs": {"release": "step6-wire@1.0.0", "environment": "wire", "user_agent": "step6"}}
    STATE["session_id"] = sid
    send("item-session", EP, envelope(env_header(), item({"type": "session"}, sess)), H)
    aggs = {"aggregates": [{"started": iso(t - t % 60), "exited": 3, "errored": 1, "crashed": 0}], "attrs": {"release": "step6-wire@1.0.0", "environment": "wire"}}
    send("item-sessions", EP, envelope(env_header(), item({"type": "sessions"}, aggs)), H)
    cr = {"timestamp": t, "discarded_events": [{"reason": "ratelimit_backoff", "category": "replay", "quantity": 2}, {"reason": "sample_rate", "category": "transaction", "quantity": 5}]}
    send("item-client_report", EP, envelope(env_header(), item({"type": "client_report"}, cr)), H)
    spanv2 = {"items": [{"trace_id": trace, "span_id": hexid()[:16], "parent_span_id": root, "name": "step6 span v2", "status": "ok", "is_segment": False,
                         "start_timestamp": t - 1, "end_timestamp": t - 0.5,
                         "attributes": {"sentry.op": {"type": "string", "value": "step6.v2"}, "step6.n": {"type": "integer", "value": 7}}}]}
    send("item-span-v2-container", EP, envelope(env_header(trace=dsc), item({"type": "span", "item_count": 1, "content_type": "application/vnd.sentry.items.span.v2+json"}, spanv2)), H)
    span1 = {"trace_id": trace, "span_id": hexid()[:16], "parent_span_id": root, "op": "ui.render", "description": "step6 legacy span", "start_timestamp": t - 1, "timestamp": t - 0.2, "is_segment": False}
    send("item-span-legacy", EP, envelope(env_header(trace=dsc), item({"type": "span"}, span1)), H)
    logs = {"items": [{"timestamp": t, "trace_id": trace, "span_id": root, "level": "info", "body": "step6 wire log",
                       "attributes": {"step6.k": {"type": "string", "value": "v"}, "sentry.release": {"type": "string", "value": "step6-wire@1.0.0"}}},
                      {"timestamp": t, "trace_id": trace, "level": "warn", "body": "step6 wire log 2", "attributes": {}}]}
    send("item-log-container", EP, envelope(env_header(), item({"type": "log", "item_count": 2, "content_type": "application/vnd.sentry.items.log+json"}, logs)), H)
    send("item-log-count-mismatch", EP, envelope(env_header(), item({"type": "log", "item_count": 5, "content_type": "application/vnd.sentry.items.log+json"}, logs)), H, note="item_count 5 but 2 items")
    tm = {"items": [{"timestamp": t, "trace_id": trace, "name": "step6.clicks", "type": "counter", "value": 3, "unit": "none", "attributes": {"route": {"type": "string", "value": "/step6"}}}]}
    send("item-trace_metric-container", EP, envelope(env_header(), item({"type": "trace_metric", "item_count": 1, "content_type": "application/vnd.sentry.items.trace-metric+json"}, tm)), H)
    ci = {"check_in_id": hexid(), "monitor_slug": "step6-wire-cron", "status": "ok", "duration": 1.25, "environment": "wire",
          "monitor_config": {"schedule": {"type": "crontab", "value": "*/5 * * * *"}, "checkin_margin": 5, "max_runtime": 10, "timezone": "UTC"}}
    send("item-check_in", EP, envelope(env_header(), item({"type": "check_in"}, ci)), H)
    ur = {"event_id": STATE["error_event_id"], "name": "Wire Tester", "email": "wire@example.invalid", "comments": "step6 user_report (legacy)"}
    send("item-user_report", EP, envelope(env_header(STATE["error_event_id"]), item({"type": "user_report"}, ur)), H)
    fid = hexid()
    fb = {"event_id": fid, "timestamp": t, "platform": "javascript", "level": "info", "release": "step6-wire@1.0.0", "environment": "wire",
          "contexts": {"feedback": {"message": "step6 feedback item", "contact_email": "wire@example.invalid", "name": "Wire Tester", "source": "widget", "associated_event_id": STATE["error_event_id"]}}}
    STATE["feedback_id"] = fid
    send("item-feedback", EP, envelope(env_header(fid), item({"type": "feedback"}, fb)), H)
    aid = hexid()
    ev = {"event_id": aid, "message": "step6-wire with attachment", "level": "error", "timestamp": t, "platform": "javascript"}
    STATE["attachment_event_id"] = aid
    send("item-attachment", EP, envelope(env_header(aid), item({"type": "event"}, ev),
                                         item({"type": "attachment", "filename": "step6.txt", "content_type": "text/plain", "attachment_type": "event.attachment"}, b"hello attachment\nline 2\n")), H)
    send("item-attachment-no-event", EP, envelope(env_header(hexid()), item({"type": "attachment", "filename": "orphan.txt"}, b"orphan")), H, note="attachment without an event item")
    send("item-unknown-type", EP, envelope(env_header(), item({"type": "step6_future_item"}, {"x": 1})), H)
    send("item-integration-forbidden", EP, envelope(env_header(), item({"type": "integration", "content_type": "application/vnd.sentry.integration.otel.logs+json"}, {"resourceLogs": []})), H)
    send("item-profile_chunk-minimal", EP, envelope(env_header(), item({"type": "profile_chunk", "platform": "javascript"}, {"version": "2", "chunk_id": hexid(), "profiler_id": hexid(), "platform": "javascript", "profile": {"samples": [], "stacks": [], "frames": [], "thread_metadata": {}}})), H, note="structurally minimal; accepted at the edge, validity decided async")

    # ---- replay ------------------------------------------------------------------
    rid = hexid()
    STATE["replay_id"] = rid
    rrweb = [
        {"type": 4, "timestamp": int(t * 1000), "data": {"href": "http://localhost/step6", "width": 800, "height": 600}},
        {"type": 2, "timestamp": int(t * 1000), "data": {"node": {"type": 0, "childNodes": [{"type": 2, "tagName": "html", "attributes": {}, "childNodes": [
            {"type": 2, "tagName": "body", "attributes": {}, "childNodes": [{"type": 3, "textContent": "my card 4111 1111 1111 1111", "id": 4}], "id": 3}], "id": 2}], "id": 1},
            "initialOffset": {"left": 0, "top": 0}}},
        {"type": 5, "timestamp": int(t * 1000) + 10, "data": {"tag": "breadcrumb", "payload": {"type": "default", "category": "console", "timestamp": t,
                                                                                         "message": "password=hunter2 card 4111 1111 1111 1111", "data": {"arg": "secret=abc"}}}},
        {"type": 5, "timestamp": int(t * 1000) + 20, "data": {"tag": "performanceSpan", "payload": {"op": "resource.fetch", "description": "https://api.example.invalid/?token=4111111111111111", "startTimestamp": t, "endTimestamp": t + 0.1, "data": {"method": "GET", "statusCode": 200}}}},
    ]
    STATE["rrweb_events"] = len(rrweb)
    rec = b'{"segment_id":0}\n' + zlib.compress(json.dumps(rrweb).encode())
    revent = {"type": "replay_event", "replay_id": rid, "event_id": rid, "segment_id": 0, "replay_type": "session", "timestamp": t, "replay_start_timestamp": t - 1,
              "urls": ["http://localhost/step6"], "error_ids": [STATE["error_event_id"]], "trace_ids": [trace], "platform": "javascript",
              "release": "step6-wire@1.0.0", "environment": "wire", "sdk": {"name": "step6.wire", "version": "0.0.1"},
              "contexts": {"replay": {"session_sample_rate": 1.0, "error_sample_rate": 1.0}}, "user": {"id": "step6-user"}}
    send("item-replay-web-segment0", EP, envelope(env_header(rid), item({"type": "replay_event"}, revent), item({"type": "replay_recording"}, rec)), H)
    rec1 = b'{"segment_id":1}\n' + json.dumps([{"type": 3, "timestamp": int(t * 1000) + 500, "data": {"source": 2, "type": 2, "id": 4, "x": 10, "y": 10}}]).encode()
    revent1 = dict(revent, segment_id=1, timestamp=t + 1, urls=[], error_ids=[], trace_ids=[])
    send("item-replay-web-segment1-uncompressed", EP, envelope(env_header(rid), item({"type": "replay_event"}, revent1), item({"type": "replay_recording"}, rec1)), H, note="recording body not compressed (starts with '[')")
    rec_g = b'{"segment_id":2}\n' + gzip.compress(json.dumps(rrweb[:1]).encode())
    send("item-replay-web-segment2-gzip-body", EP, envelope(env_header(rid), item({"type": "replay_event"}, dict(revent, segment_id=2, timestamp=t + 2)), item({"type": "replay_recording"}, rec_g)), H, note="recording body gzip instead of zlib")
    send("item-replay-event-only", EP, envelope(env_header(rid), item({"type": "replay_event"}, dict(revent, segment_id=3))), H, note="replay_event without replay_recording")
    send("item-replay-recording-only", EP, envelope(env_header(rid), item({"type": "replay_recording"}, b'{"segment_id":4}\n' + zlib.compress(b"[]"))), H, note="standalone recording")
    send("item-replay-two-events", EP, envelope(env_header(rid), item({"type": "replay_event"}, dict(revent, segment_id=5)), item({"type": "replay_event"}, dict(revent, segment_id=5)), item({"type": "replay_recording"}, rec)), H)

    def mp_bin(b):
        n = len(b)
        if n < 256:
            return b"\xc4" + bytes([n]) + b
        if n < 65536:
            return b"\xc5" + struct.pack(">H", n) + b
        return b"\xc6" + struct.pack(">I", n) + b

    def mp_str(s):
        b = s.encode()
        return bytes([0xA0 | len(b)]) + b

    vid = hexid()
    STATE["video_replay_id"] = vid
    vev = dict(revent, replay_id=vid, event_id=vid, platform="android", replay_type="session", error_ids=[], trace_ids=[], urls=[])
    vrec = b'{"segment_id":0}\n' + json.dumps([{"type": 5, "timestamp": int(t * 1000), "data": {"tag": "video", "payload": {"segmentId": 0, "size": 16, "duration": 5000, "encoding": "h264", "container": "mp4", "height": 640, "width": 360, "frameCount": 5, "frameRate": 1, "frameRateType": "constant", "left": 0, "top": 0}}}]).encode()
    video = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 8
    mp = b"\x83" + mp_str("replay_event") + mp_bin(json.dumps(vev).encode()) + mp_str("replay_recording") + mp_bin(vrec) + mp_str("replay_video") + mp_bin(video)
    send("item-replay_video", EP, envelope(env_header(vid), item({"type": "replay_video"}, mp)), H, note="msgpack map {replay_event, replay_recording, replay_video}")
    send("item-replay_video-empty-video", EP, envelope(env_header(hexid()), item({"type": "replay_video"}, b"\x83" + mp_str("replay_event") + mp_bin(json.dumps(vev).encode()) + mp_str("replay_recording") + mp_bin(vrec) + mp_str("replay_video") + mp_bin(b""))), H)

    # ---- size limits -------------------------------------------------------------
    big = {"event_id": hexid(), "message": "step6-wire big", "timestamp": now(), "extra": {"blob": "x" * (1024 * 1024 + 10)}}
    send("limit-event-over-1MiB", EP, envelope(env_header(big["event_id"]), item({"type": "event"}, big)), H, note="event item > max_event_size (1 MiB)")
    blog = {"items": [{"timestamp": now(), "level": "info", "body": "x" * (2 * 1024 * 1024 + 10), "attributes": {}}]}
    send("limit-log-over-2MiB", EP, envelope(env_header(), item({"type": "log", "item_count": 1, "content_type": "application/vnd.sentry.items.log+json"}, blog)), H)
    brec = b'{"segment_id":9}\n' + os.urandom(10 * 1024 * 1024 + 10)
    send("limit-replay-recording-over-10MiB", EP, envelope(env_header(rid), item({"type": "replay_event"}, dict(revent, segment_id=9)), item({"type": "replay_recording"}, brec)), H)
    many = envelope(env_header(), *[item({"type": "client_report"}, {"timestamp": now(), "discarded_events": []}) for _ in range(101)])
    send("limit-101-client-reports", EP, many, H, note="max_client_reports_count = 100")
    many = envelope(env_header(), *[item({"type": "step6_x"}, b"{}") for _ in range(501)])
    send("limit-501-items", EP, many, H, note="MAX_ENVELOPE_ITEMS = 500")
    bomb = gzip.compress(b'{"event_id":"' + hexid().encode() + b'"}\n{"type":"attachment","length":' + str(210 * 1024 * 1024).encode() + b'}\n' + b"\0" * (210 * 1024 * 1024) + b"\n")
    send("limit-gzip-210MiB-decompressed", EP, bomb, dict(H, **{"Content-Encoding": "gzip"}), note=f"{len(bomb)} compressed bytes, 210 MiB after gunzip (> max_envelope_size 200 MiB)")
    send("limit-nginx-101MiB-raw", EP, b'{}\n{"type":"attachment","length":105906176}\n' + b"\0" * 105906176 + b"\n", H, note="raw body > nginx client_max_body_size 100m")

    # ---- other endpoints ----------------------------------------------------------
    sev = {"event_id": hexid(), "message": "step6-wire legacy store", "level": "warning", "platform": "javascript", "timestamp": now()}
    send("endpoint-store-json", f"/api/{PID}/store/", json.dumps(sev).encode(), {"X-Sentry-Auth": auth(), "Content-Type": "application/json"})
    send("endpoint-store-envelope-content-type", f"/api/{PID}/store/", error_env("step6-wire envelope via store")[1], {"X-Sentry-Auth": auth(), "Content-Type": "application/x-sentry-envelope"}, note="store endpoint given an envelope")
    csp = {"csp-report": {"document-uri": "http://localhost/step6", "referrer": "", "violated-directive": "script-src", "effective-directive": "script-src",
                          "original-policy": "default-src 'self'; report-uri /x", "blocked-uri": "http://evil.example.invalid/x.js", "status-code": 200}}
    send("endpoint-security-csp", f"/api/{PID}/security/?sentry_key={KEY}&sentry_environment=wire", json.dumps(csp).encode(), {"Content-Type": "application/csp-report"})
    nel = [{"age": 0, "type": "network-error", "url": "http://localhost/step6", "user_agent": "step6", "body": {"elapsed_time": 10, "method": "GET", "phase": "connection", "protocol": "http/1.1", "referrer": "", "sampling_fraction": 1, "server_ip": "", "status_code": 0, "type": "tcp.refused"}}]
    send("endpoint-nel", f"/api/{PID}/nel/?sentry_key={KEY}", json.dumps(nel).encode(), {"Content-Type": "application/reports+json"})
    send("endpoint-minidump-garbage", f"/api/{PID}/minidump/?sentry_key={KEY}", b"--b\r\nContent-Disposition: form-data; name=\"upload_file_minidump\"; filename=\"m.dmp\"\r\nContent-Type: application/octet-stream\r\n\r\nnot a minidump\r\n--b--\r\n",
         {"Content-Type": "multipart/form-data; boundary=b"})
    send("endpoint-unreal-garbage", f"/api/{PID}/unreal/{KEY}/", b"not an unreal crash", {"Content-Type": "application/octet-stream"})
    send("endpoint-cron-get", f"/api/{PID}/cron/step6-wire-http-cron/{KEY}/?status=ok", None, {}, method="GET")

    # OTLP
    otlp_t = {"resourceSpans": [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "step6-wire-otlp"}}]},
                                 "scopeSpans": [{"scope": {"name": "step6"}, "spans": [{"traceId": trace, "spanId": hexid()[:16], "parentSpanId": root, "name": "otlp json span", "kind": 3,
                                                                                        "startTimeUnixNano": str(int((t - 1) * 1e9)), "endTimeUnixNano": str(int(t * 1e9)),
                                                                                        "attributes": [{"key": "http.request.method", "value": {"stringValue": "GET"}}], "status": {"code": 1}}]}]}]}
    OT = f"/api/{PID}/integration/otlp/v1/traces"
    send("otlp-traces-json", OT, json.dumps(otlp_t).encode(), {"Content-Type": "application/json", "X-Sentry-Auth": f"sentry sentry_key={KEY}"})
    send("otlp-traces-json-trailing-slash", OT + "/", json.dumps(otlp_t).encode(), {"Content-Type": "application/json", "X-Sentry-Auth": f"sentry sentry_key={KEY}"})
    send("otlp-traces-gzip", OT, gzip.compress(json.dumps(otlp_t).encode()), {"Content-Type": "application/json", "Content-Encoding": "gzip", "X-Sentry-Auth": f"sentry sentry_key={KEY}"})
    send("otlp-traces-protobuf", OT, otlp_trace_pb(trace, root, t), {"Content-Type": "application/x-protobuf", "X-Sentry-Auth": f"sentry sentry_key={KEY}"})
    send("otlp-traces-bad-content-type", OT, b"x", {"Content-Type": "text/plain", "X-Sentry-Auth": f"sentry sentry_key={KEY}"})
    send("otlp-traces-no-auth", OT, json.dumps(otlp_t).encode(), {"Content-Type": "application/json"})
    send("otlp-traces-bearer-auth", OT, json.dumps(otlp_t).encode(), {"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"}, note="Authorization: Bearer is not an accepted form")
    otlp_l = {"resourceLogs": [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "step6-wire-otlp"}}]},
                                "scopeLogs": [{"scope": {"name": "step6"}, "logRecords": [{"timeUnixNano": str(int(t * 1e9)), "severityNumber": 9, "severityText": "INFO",
                                                                                           "body": {"stringValue": "otlp json log"}, "traceId": trace, "spanId": root,
                                                                                           "attributes": [{"key": "step6.k", "value": {"stringValue": "v"}}]}]}]}]}
    send("otlp-logs-json", f"/api/{PID}/integration/otlp/v1/logs", json.dumps(otlp_l).encode(), {"Content-Type": "application/json", "X-Sentry-Auth": f"sentry sentry_key={KEY}"})
    send("otlp-metrics-json", f"/api/{PID}/integration/otlp/v1/metrics", b"{}", {"Content-Type": "application/json", "X-Sentry-Auth": f"sentry sentry_key={KEY}"}, note="metrics are not an OTLP route in Relay 26.10.0")
    send("otlp-short-path", f"/api/{PID}/otlp/v1/traces", json.dumps(otlp_t).encode(), {"Content-Type": "application/json", "X-Sentry-Auth": f"sentry sentry_key={KEY}"}, note="path without /integration/")

    with open(os.path.join(OUT, "_ids.json"), "w") as f:
        json.dump({k: v for k, v in STATE.items()}, f, indent=2)


def pb_varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def pb_field(num, wt, payload):
    key = pb_varint((num << 3) | wt)
    if wt == 2:
        return key + pb_varint(len(payload)) + payload
    return key + payload


def otlp_trace_pb(trace, parent, t):
    kv = pb_field(1, 2, b"service.name") + pb_field(2, 2, pb_field(1, 2, b"step6-wire-otlp"))
    resource = pb_field(1, 2, kv)
    span = (pb_field(1, 2, bytes.fromhex(trace)) + pb_field(2, 2, bytes.fromhex(hexid()[:16])) + pb_field(4, 2, bytes.fromhex(parent))
            + pb_field(5, 2, b"otlp protobuf span") + pb_field(6, 0, pb_varint(2))
            + pb_field(7, 1, struct.pack("<Q", int((t - 1) * 1e9))) + pb_field(8, 1, struct.pack("<Q", int(t * 1e9))))
    scope_spans = pb_field(1, 2, pb_field(1, 2, b"step6")) + pb_field(2, 2, span)
    rs = pb_field(1, 2, resource) + pb_field(2, 2, scope_spans)
    return pb_field(1, 2, rs)


main()
