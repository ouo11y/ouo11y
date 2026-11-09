#!/usr/bin/env python3
"""Check how a real Collector and Loki treat edge cases of the logs model.

Needs a Collector (debug exporter) on COL and Loki on LOKI; see the summary for
the docker commands. argv[1] is the directory of .pb files from wire_size.py.
"""
import base64, glob, gzip, json, os, sys, time, urllib.parse, urllib.request as u
COL = "http://127.0.0.1:34318"; LOKI = "http://127.0.0.1:33100"
def post(url, body, ctype="application/json", hdr=None):
    r = u.Request(url, body, {"Content-Type": ctype, **(hdr or {})})
    try:
        with u.urlopen(r, timeout=120) as x: return x.status, x.read()[:400]
    except u.HTTPError as e: return e.code, e.read()[:400]
    except Exception as e: return "conn", repr(e)[:200].encode()
print("# Collector decodes protobuf bodies")
for f in sorted(glob.glob(sys.argv[1] + "/*-1.pb")):
    sig = os.path.basename(f).split("-")[0]
    print(os.path.basename(f), post(f"{COL}/v1/{sig}", open(f, "rb").read(), "application/x-protobuf"))
print("# Collector size limit (default 20 MiB)")
big = lambda n: json.dumps({"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"a"*n}}]}]}]}).encode()
print("19 MiB", post(f"{COL}/v1/logs", big(19<<20))[0])
st, b = post(f"{COL}/v1/logs", big(21<<20)); print("21 MiB", st, b[:120])
z = gzip.compress(big(21<<20)); print("21 MiB decompressed, sent as gzip of", len(z), post(f"{COL}/v1/logs", z, hdr={"Content-Encoding":"gzip"})[:2])
now = int(time.time()*1e9); run = str(int(time.time()))
def rec(svc, records):
    return json.dumps({"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":svc+run}}]},"scopeLogs":[{"scope":{"name":"t"},"logRecords":records}]}]}).encode()
def L(svc, records):
    s = post(f"{LOKI}/otlp/v1/logs", rec(svc, records)); print(svc, "->", s); return svc+run
print("# Loki")
names = {}
base = {"timeUnixNano":str(now),"observedTimeUnixNano":str(now+5)}
names["event"] = L("event", [{**base,"eventName":"ouo.replay.chunk","severityNumber":9,"severityText":"INFO","traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","flags":1,"body":{"stringValue":"hello"},"attributes":[{"key":"session.id","value":{"stringValue":"s1"}},{"key":"n.m","value":{"kvlistValue":{"values":[{"key":"x","value":{"intValue":"1"}}]}}}]}])
names["bytes"] = L("bytes", [{**base,"body":{"bytesValue":base64.b64encode(b"\x00\x01binary\xff").decode()}}])
names["map"] = L("map", [{**base,"body":{"kvlistValue":{"values":[{"key":"a","value":{"intValue":"1"}},{"key":"b","value":{"stringValue":"x"}}]}}}])
names["nobody"] = L("nobody", [{**base}])
names["big"] = L("big", [{**base,"body":{"stringValue":"small-ok"}},{**base,"body":{"stringValue":"z"*(300*1024)}}])
names["bigattr"] = L("bigattr", [{**base,"body":{"stringValue":"ok"},"attributes":[{"key":"exception.stacktrace","value":{"stringValue":"y"*(70*1024)}}]},{**base,"body":{"stringValue":"small-ok"}}])
names["fut5m"] = L("fut5m", [{"timeUnixNano":str(now+5*60*10**9),"body":{"stringValue":"plus5m"}}])
names["fut1h"] = L("fut1h", [{"timeUnixNano":str(now+3600*10**9),"body":{"stringValue":"plus1h"}}])
names["old8d"] = L("old8d", [{"timeUnixNano":str(now-8*86400*10**9),"body":{"stringValue":"minus8d"}}])
names["obsonly"] = L("obsonly", [{"observedTimeUnixNano":str(now-60*10**9),"body":{"stringValue":"observed only"}}])
names["notime"] = L("notime", [{"body":{"stringValue":"no timestamps"}}])
time.sleep(4)
for k, svc in names.items():
    q = urllib.parse.urlencode({"query":'{service_name="%s"}'%svc,"start":now-9*86400*10**9,"end":now+2*3600*10**9,"limit":10,"direction":"forward"})
    r = u.Request(f"{LOKI}/loki/api/v1/query_range?{q}", headers={"X-Loki-Response-Encoding-Flags":"categorize-labels"})
    d = json.load(u.urlopen(r, timeout=60))
    res = d["data"]["result"]
    print("==", k, "streams", len(res))
    for st in res:
        print("  labels", st["stream"])
        for v in st["values"]:
            print("  ts_delta_s", round((int(v[0])-now)/1e9,1), "line", repr(v[1][:60]), "len", len(v[1]), "meta", json.dumps(v[2] if len(v)>2 else {})[:420])
