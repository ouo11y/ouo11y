"""Re-encodes captured OTLP/JSON request bodies (ouo web SDK, one 60 s journey) as OTLP protobuf,
with a minimal encoder for the logs and traces messages, and compares sizes raw and gzip-9.
Usage: python3 json_vs_proto.py <bodies-dir>  (files written by server.mjs with SAVE_BODIES)."""
import gzip, json, os, struct, sys

def varint(n):
    n &= (1 << 64) - 1; out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def key(f, wt): return varint((f << 3) | wt)
def ld(f, b): return key(f, 2) + varint(len(b)) + b
def s(f, v): return ld(f, v.encode()) if v else b''
def fx64(f, v): return key(f, 1) + struct.pack('<Q', int(v)) if v else b''
def fx32(f, v): return key(f, 5) + struct.pack('<I', int(v)) if v else b''
def vi(f, v): return key(f, 0) + varint(int(v)) if v else b''
def hexb(f, v): return ld(f, bytes.fromhex(v)) if v else b''
def anyv(v):
    if 'stringValue' in v: return ld(1, v['stringValue'].encode())
    if 'boolValue' in v: return key(2, 0) + varint(1 if v['boolValue'] else 0)
    if 'intValue' in v: return key(3, 0) + varint(int(v['intValue']))
    if 'doubleValue' in v: return key(4, 1) + struct.pack('<d', float(v['doubleValue']))
    if 'arrayValue' in v: return ld(5, b''.join(ld(1, anyv(x)) for x in v['arrayValue'].get('values', [])))
    if 'kvlistValue' in v: return ld(6, b''.join(ld(1, kv(x)) for x in v['kvlistValue'].get('values', [])))
    if 'bytesValue' in v: return ld(7, v['bytesValue'].encode())
    return b''
def kv(x): return s(1, x['key']) + ld(2, anyv(x.get('value', {})))
def attrs(f, a): return b''.join(ld(f, kv(x)) for x in a or [])
def resource(r): return attrs(1, r.get('attributes')) + vi(2, r.get('droppedAttributesCount', 0))
def scope(sc): return s(1, sc.get('name', '')) + s(2, sc.get('version', '')) + attrs(3, sc.get('attributes'))
def logrec(l):
    return (fx64(1, l.get('timeUnixNano', 0)) + vi(2, l.get('severityNumber', 0)) + s(3, l.get('severityText', '')) +
            (ld(5, anyv(l['body'])) if l.get('body') else b'') + attrs(6, l.get('attributes')) + vi(7, l.get('droppedAttributesCount', 0)) +
            fx32(8, l.get('flags', 0)) + hexb(9, l.get('traceId', '')) + hexb(10, l.get('spanId', '')) +
            fx64(11, l.get('observedTimeUnixNano', 0)) + s(12, l.get('eventName', '')))
def span(sp):
    ev = b''.join(ld(11, fx64(1, e.get('timeUnixNano', 0)) + s(2, e.get('name', '')) + attrs(3, e.get('attributes'))) for e in sp.get('events', []))
    st = sp.get('status', {}); stb = s(2, st.get('message', '')) + vi(3, st.get('code', 0))
    return (hexb(1, sp.get('traceId', '')) + hexb(2, sp.get('spanId', '')) + s(3, sp.get('traceState', '')) + hexb(4, sp.get('parentSpanId', '')) +
            s(5, sp.get('name', '')) + vi(6, sp.get('kind', 0)) + fx64(7, sp.get('startTimeUnixNano', 0)) + fx64(8, sp.get('endTimeUnixNano', 0)) +
            attrs(9, sp.get('attributes')) + ev + (ld(15, stb) if stb else b'') + fx32(16, sp.get('flags', 0)))
def logs_req(j):
    return b''.join(ld(1, ld(1, resource(rl.get('resource', {}))) + b''.join(
        ld(2, ld(1, scope(sl.get('scope', {}))) + b''.join(ld(2, logrec(l)) for l in sl.get('logRecords', [])) + s(3, sl.get('schemaUrl', '')))
        for sl in rl.get('scopeLogs', [])) + s(3, rl.get('schemaUrl', ''))) for rl in j.get('resourceLogs', []))
def traces_req(j):
    return b''.join(ld(1, ld(1, resource(rs.get('resource', {}))) + b''.join(
        ld(2, ld(1, scope(ss.get('scope', {}))) + b''.join(ld(2, span(x)) for x in ss.get('spans', [])) + s(3, ss.get('schemaUrl', '')))
        for ss in rs.get('scopeSpans', [])) + s(3, rs.get('schemaUrl', ''))) for rs in j.get('resourceSpans', []))

d = sys.argv[1]; tot = {}
for f in sorted(os.listdir(d)):
    kind = 'logs' if '_v1_logs' in f else 'traces' if '_v1_traces' in f else None
    if not kind: continue
    raw = open(os.path.join(d, f), 'rb').read()
    js = gzip.decompress(raw) if f.endswith('.gz') else raw
    pb = (logs_req if kind == 'logs' else traces_req)(json.loads(js))
    t = tot.setdefault(kind, {'requests': 0, 'json': 0, 'json_gz': 0, 'proto': 0, 'proto_gz': 0, 'records': 0})
    t['requests'] += 1; t['json'] += len(js); t['json_gz'] += len(gzip.compress(js, 9)); t['proto'] += len(pb); t['proto_gz'] += len(gzip.compress(pb, 9))
    jj = json.loads(js); t['records'] += sum(len(sl.get('logRecords', [])) for rl in jj.get('resourceLogs', []) for sl in rl.get('scopeLogs', [])) + sum(len(ss.get('spans', [])) for rs in jj.get('resourceSpans', []) for ss in rs.get('scopeSpans', []))
for k, t in tot.items():
    print(k, t, f"proto/json raw {t['proto']/t['json']:.2f}, gz {t['proto_gz']/t['json_gz']:.2f}")
print(json.dumps(tot))
