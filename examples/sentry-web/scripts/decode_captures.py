"""Decode sentrytap captures (Step 6 research). Usage: python3 -I decode_captures.py <capture dir>
Prints one line per request: time, content type, status, envelope header keys, items (replay recordings are decompressed).
"""
import sys, os, json, zlib, gzip

def parse_envelope(body):
    pos = body.find(b"\n")
    hdr = json.loads(body[:pos] if pos >= 0 else body)
    items = []
    pos = pos + 1 if pos >= 0 else len(body)
    while pos < len(body):
        nl = body.find(b"\n", pos)
        if nl < 0: nl = len(body)
        line = body[pos:nl]
        if not line.strip():
            pos = nl + 1; continue
        ih = json.loads(line)
        pos = nl + 1
        if "length" in ih:
            payload = body[pos:pos + ih["length"]]; pos += ih["length"] + 1
        else:
            nl = body.find(b"\n", pos)
            if nl < 0: nl = len(body)
            payload = body[pos:nl]; pos = nl + 1
        items.append((ih, payload))
    return hdr, items

def decode_recording(payload):
    nl = payload.find(b"\n")
    head = json.loads(payload[:nl]); rest = payload[nl + 1:]
    kind = "plain"
    if rest[:2] == b"\x1f\x8b": rest = gzip.decompress(rest); kind = "gzip"
    elif rest[:1] == b"\x78": rest = zlib.decompress(rest); kind = "zlib"
    return head, kind, json.loads(rest)

def load(d):
    req = json.load(open(os.path.join(d, "request.json")))
    body = open(os.path.join(d, "body.bin"), "rb").read()
    enc = (req["header"].get("Content-Encoding") or [""])[0]
    if enc == "gzip": body = gzip.decompress(body)
    elif enc == "deflate": body = zlib.decompress(body)
    return req, body

if __name__ == "__main__":
    cap = sys.argv[1]
    for name in sorted(os.listdir(cap)):
        d = os.path.join(cap, name)
        try: req, body = load(d)
        except Exception as e: print(name, "ERR", e); continue
        resp = json.load(open(os.path.join(d, "response.json")))
        try: hdr, items = parse_envelope(body)
        except Exception as e: print(name, "not envelope", e, body[:80]); continue
        desc = []
        for ih, p in items:
            t = ih.get("type"); extra = ""
            if t in ("event", "transaction", "feedback"):
                j = json.loads(p); extra = (j.get("exception", {}).get("values", [{}])[-1].get("value") or j.get("message") or j.get("transaction") or "")[:40]
            if t == "replay_event":
                j = json.loads(p); extra = "seg=%s type=%s" % (j.get("segment_id"), j.get("replay_type"))
            if t == "replay_recording":
                h, k, ev = decode_recording(p); extra = "%s %s n=%d types=%s" % (h, k, len(ev), sorted(set(e["type"] for e in ev)))
            if t == "client_report":
                extra = p.decode()[:200]
            if t in ("log", "span", "trace_metric"):
                extra = "items=%s" % ih.get("item_count")
            desc.append("%s(%d)%s" % (t, len(p), (" " + extra) if extra else ""))
        print(name, req["time"][11:19], req.get("header", {}).get("Content-Type"), resp["status"], "hdr:" + ",".join(sorted(hdr.keys())), "|", " ; ".join(desc))
