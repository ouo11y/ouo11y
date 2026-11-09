#!/usr/bin/env python3
"""Measure OTLP wire size of one RUM-shaped fact as log event, span and metric.

Standard library only. Hand-rolled protobuf encoder using the field numbers from
opentelemetry-proto v1.11.1. Writes the request bodies to OUT (argv[1]) so a real
Collector can check that they decode, and prints a JSON table of sizes.
"""
import gzip, json, os, random, struct, sys

# protobuf primitives
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else:
            out.append(b); return bytes(out)
def tag(f, w): return varint(f << 3 | w)
def ld(f, b): return tag(f, 2) + varint(len(b)) + b
def s(f, v): return ld(f, v.encode()) if v else b""
def fx64(f, v): return tag(f, 1) + struct.pack("<Q", v) if v else b""
def fx32(f, v): return tag(f, 5) + struct.pack("<I", v) if v else b""
def dbl(f, v): return tag(f, 1) + struct.pack("<d", v)
def vi(f, v): return tag(f, 0) + varint(v) if v else b""

def anyv(v):
    if isinstance(v, bool): return tag(2, 0) + varint(int(v))
    if isinstance(v, int): return tag(3, 0) + varint(v)
    if isinstance(v, float): return dbl(4, v)
    if isinstance(v, (bytes, bytearray)): return ld(7, bytes(v))
    return ld(1, v.encode())
def kv(k, v): return s(1, k) + ld(2, anyv(v))
def attrs(f, d): return b"".join(ld(f, kv(k, v)) for k, v in d.items())
def resource(d): return attrs(1, d)
def scope(n, v): return s(1, n) + s(2, v)

# json helpers
def janyv(v):
    if isinstance(v, bool): return {"boolValue": v}
    if isinstance(v, int): return {"intValue": str(v)}
    if isinstance(v, float): return {"doubleValue": v}
    return {"stringValue": v}
def jattrs(d): return [{"key": k, "value": janyv(v)} for k, v in d.items()]
def jres(d): return {"attributes": jattrs(d)}

RES = {
    "service.name": "shop-web", "service.version": "2.14.0",
    "deployment.environment.name": "production",
    "telemetry.sdk.name": "ouo", "telemetry.sdk.language": "webjs",
    "telemetry.sdk.version": "0.3.0", "browser.language": "en-US",
}
SCOPE = ("ouo.web", "0.3.0")
SESSION = "00112233-4455-6677-8899-aabbccddeeff"
T0 = 1793000000000000000

def fact(r, i):
    """One user-visible API call, varied the way real values vary."""
    return {
        "t": T0 + i * 1_700_000_000 + r.randrange(10**6),
        "dur": r.randrange(40, 900) * 1_000_000,
        "trace": r.randbytes(16), "span": r.randbytes(8), "parent": r.randbytes(8),
        "attrs": {
            "session.id": SESSION,
            "http.request.method": r.choice(["GET", "POST"]),
            "url.path": "/api/cart/%d" % r.randrange(1000),
            "http.response.status_code": r.choice([200, 200, 200, 404, 500]),
            "url.domain": "shop.example.com",
            "user_agent.synthetic.type": "none",
        },
    }

def pb_log(f, event=True, trace=True):
    b = fx64(1, f["t"]) + vi(2, 9) + attrs(6, f["attrs"]) + fx64(11, f["t"])
    if trace: b += fx32(8, 1) + ld(9, f["trace"]) + ld(10, f["span"])
    if event: b += s(12, "ouo.http.request")
    return b
def pb_span(f, n_events=0):
    b = ld(1, f["trace"]) + ld(2, f["span"]) + ld(4, f["parent"]) + s(5, "GET /api/cart")
    b += vi(6, 3) + fx64(7, f["t"]) + fx64(8, f["t"] + f["dur"]) + attrs(9, f["attrs"])
    for i in range(n_events):
        b += ld(11, fx64(1, f["t"] + 1000) + s(2, "response.first_byte"))
    b += fx32(16, 0x101)
    return b
BOUNDS = [0.0, 5.0, 10.0, 25.0, 50.0, 75.0, 100.0, 250.0, 500.0, 750.0, 1000.0, 2500.0, 5000.0, 7500.0, 10000.0]
HIST_ATTRS = {"http.request.method": "GET", "http.response.status_code": 200, "url.domain": "shop.example.com"}
def bucket(ms):
    for i, b in enumerate(BOUNDS):
        if ms <= b: return i
    return len(BOUNDS)
def pb_hist_point(vals, start, end):
    counts = [0] * 16
    for v in vals: counts[bucket(v)] += 1
    b = fx64(2, start) + fx64(3, end) + tag(4, 1) + struct.pack("<Q", len(vals)) + dbl(5, float(sum(vals)))
    b += ld(6, b"".join(struct.pack("<Q", c) for c in counts))
    b += ld(7, b"".join(struct.pack("<d", x) for x in BOUNDS))
    b += attrs(9, HIST_ATTRS) + dbl(11, min(vals)) + dbl(12, max(vals))
    return b
def env(rec_field, records, scope_field=2, res_field=1):
    sc = ld(1, scope(*SCOPE)) + b"".join(ld(2, x) for x in records)
    rs = ld(1, resource(RES)) + ld(scope_field, sc)
    return ld(res_field, rs)
def hist_env(vals, start, end):
    h = ld(1, pb_hist_point(vals, start, end)) + vi(2, 1)   # DELTA
    m = s(1, "http.client.request.duration") + s(3, "ms") + ld(9, h)
    return env(None, [m])

def hx(b): return b.hex()
def j_log(f, event=True, trace=True):
    d = {"timeUnixNano": str(f["t"]), "observedTimeUnixNano": str(f["t"]), "severityNumber": 9, "attributes": jattrs(f["attrs"])}
    if trace: d.update(flags=1, traceId=hx(f["trace"]), spanId=hx(f["span"]))
    if event: d["eventName"] = "ouo.http.request"
    return d
def j_span(f, n_events=0):
    d = {"traceId": hx(f["trace"]), "spanId": hx(f["span"]), "parentSpanId": hx(f["parent"]), "flags": 257, "name": "GET /api/cart", "kind": 3,
         "startTimeUnixNano": str(f["t"]), "endTimeUnixNano": str(f["t"] + f["dur"]), "attributes": jattrs(f["attrs"]), "status": {}}
    if n_events: d["events"] = [{"timeUnixNano": str(f["t"] + 1000), "name": "response.first_byte"}] * n_events
    return d
def j_env(key, skey, rkey, records):
    return {key: [{"resource": jres(RES), skey: [{"scope": {"name": SCOPE[0], "version": SCOPE[1]}, rkey: records}]}]}
def j_hist(vals, start, end):
    counts = [0] * 16
    for v in vals: counts[bucket(v)] += 1
    p = {"startTimeUnixNano": str(start), "timeUnixNano": str(end), "count": str(len(vals)), "sum": float(sum(vals)),
         "bucketCounts": [str(c) for c in counts], "explicitBounds": BOUNDS, "attributes": jattrs(HIST_ATTRS), "min": min(vals), "max": max(vals)}
    m = {"name": "http.client.request.duration", "unit": "ms", "histogram": {"dataPoints": [p], "aggregationTemporality": 1}}
    return j_env("resourceMetrics", "scopeMetrics", "metrics", [m])

def sizes(pb, js):
    j = json.dumps(js, separators=(",", ":")).encode()
    return {"protobuf": len(pb), "protobuf_gzip": len(gzip.compress(pb, 6, mtime=0)), "json": len(j), "json_gzip": len(gzip.compress(j, 6, mtime=0))}

def main(out):
    os.makedirs(out, exist_ok=True)
    def run(n):
        r = random.Random(42)
        return [fact(r, i) for i in range(n)]
    rows = {}
    for n in (1, 50):
        fs = run(n)
        vals = [x["dur"] / 1e6 for x in fs]
        start, end = T0, T0 + n * 1_700_000_000
        cases = {
            "log record, no trace ids": (env(None, [pb_log(x, False, False) for x in fs]), j_env("resourceLogs", "scopeLogs", "logRecords", [j_log(x, False, False) for x in fs]), "logs"),
            "event (log record with event_name and trace ids)": (env(None, [pb_log(x) for x in fs]), j_env("resourceLogs", "scopeLogs", "logRecords", [j_log(x) for x in fs]), "logs"),
            "span": (env(None, [pb_span(x) for x in fs]), j_env("resourceSpans", "scopeSpans", "spans", [j_span(x) for x in fs]), "traces"),
            "span with 3 span events": (env(None, [pb_span(x, 3) for x in fs]), j_env("resourceSpans", "scopeSpans", "spans", [j_span(x, 3) for x in fs]), "traces"),
            "histogram point (all n aggregated, 16 buckets, delta)": (hist_env(vals, start, end), j_hist(vals, start, end), "metrics"),
        }
        for name, (pb, js, sig) in cases.items():
            rows.setdefault(name, {})[n] = sizes(pb, js)
            slug = name.split(" (")[0].replace(" ", "_").replace(",", "")
            with open(os.path.join(out, f"{sig}-{slug}-{n}.pb"), "wb") as fh: fh.write(pb)
    # average bytes per record in a batch of 50, envelope included
    for name, d in rows.items():
        d["per_record_at_50"] = {k: round(d[50][k] / 50, 1) for k in d[50]}
    print(json.dumps(rows, indent=1))

if __name__ == "__main__":
    main(sys.argv[1])
