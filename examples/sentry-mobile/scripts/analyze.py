#!/usr/bin/env python3
"""Summarise a capture made by scripts/recorder.py or collector/tools/sentrytap (stdlib only).

    python3 -I scripts/analyze.py captures/<run> [--json summary.json] [--dump-replay DIR]

Prints: requests, auth carriers, encodings, item type counts, sdk names, session updates,
events, transactions, replay_video segments (msgpack layout, replay_event fields, recording
events, mp4 header). --dump-replay writes one replay segment's parts to DIR.
"""
import argparse
import collections
import gzip
import json
import os
import struct
import sys
import zlib
from urllib.parse import parse_qs


def decode_body(raw, enc):
    if (enc or "").lower() == "gzip" or raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    if (enc or "").lower() == "deflate":
        return zlib.decompress(raw)
    return raw


def parse_envelope(body):
    first, _, rest = body.partition(b"\n")
    header = json.loads(first)
    items, pos = [], 0
    while pos < len(rest):
        nl = rest.find(b"\n", pos)
        if nl == -1:
            nl = len(rest)
        hline = rest[pos:nl].strip()
        pos = nl + 1
        if not hline:
            continue
        ih = json.loads(hline)
        if "length" in ih:
            payload = rest[pos : pos + int(ih["length"])]
            pos += int(ih["length"]) + 1
        else:
            nl2 = rest.find(b"\n", pos)
            nl2 = len(rest) if nl2 == -1 else nl2
            payload = rest[pos:nl2]
            pos = nl2 + 1
        items.append((ih, payload))
    return header, items


class Msgpack:
    """Minimal msgpack decoder: enough for maps, strings, bins, ints, floats, arrays."""

    def __init__(self, data):
        self.d, self.p, self.trace = data, 0, []

    def u(self, fmt):
        v = struct.unpack_from(">" + fmt, self.d, self.p)[0]
        self.p += struct.calcsize(fmt)
        return v

    def take(self, n):
        v = self.d[self.p : self.p + n]
        self.p += n
        return v

    def read(self):
        b = self.d[self.p]
        self.p += 1
        if b <= 0x7F:
            return b
        if 0x80 <= b <= 0x8F:
            self.trace.append(f"fixmap({b & 0x0F})")
            return self.map(b & 0x0F)
        if 0x90 <= b <= 0x9F:
            return [self.read() for _ in range(b & 0x0F)]
        if 0xA0 <= b <= 0xBF:
            return self.take(b & 0x1F).decode()
        if b == 0xC0:
            return None
        if b in (0xC2, 0xC3):
            return b == 0xC3
        if b in (0xC4, 0xC5, 0xC6):
            n = self.u({0xC4: "B", 0xC5: "H", 0xC6: "I"}[b])
            self.trace.append(f"bin{ {0xC4: 8, 0xC5: 16, 0xC6: 32}[b] }({n})")
            return self.take(n)
        if b == 0xCA:
            return self.u("f")
        if b == 0xCB:
            return self.u("d")
        if b in (0xCC, 0xCD, 0xCE, 0xCF):
            return self.u({0xCC: "B", 0xCD: "H", 0xCE: "I", 0xCF: "Q"}[b])
        if b in (0xD0, 0xD1, 0xD2, 0xD3):
            return self.u({0xD0: "b", 0xD1: "h", 0xD2: "i", 0xD3: "q"}[b])
        if b in (0xD9, 0xDA, 0xDB):
            n = self.u({0xD9: "B", 0xDA: "H", 0xDB: "I"}[b])
            self.trace.append(f"str{ {0xD9: 8, 0xDA: 16, 0xDB: 32}[b] }")
            return self.take(n).decode()
        if b in (0xDC, 0xDD):
            n = self.u("H" if b == 0xDC else "I")
            return [self.read() for _ in range(n)]
        if b in (0xDE, 0xDF):
            n = self.u("H" if b == 0xDE else "I")
            self.trace.append(f"map{16 if b == 0xDE else 32}({n})")
            return self.map(n)
        if b >= 0xE0:
            return b - 0x100
        raise ValueError(f"unsupported msgpack byte 0x{b:02x} at {self.p - 1}")

    def map(self, n):
        out = {}
        for _ in range(n):
            k = self.read()
            out[k] = self.read()
        return out


def load_requests(run):
    """Read a capture made by scripts/recorder.py (requests.jsonl) or by
    collector/tools/sentrytap (<NNNNNN>/request.json + body.bin)."""
    jl = os.path.join(run, "requests.jsonl")
    if os.path.exists(jl):
        return [json.loads(l) for l in open(jl)]
    out = []
    for d in sorted(os.listdir(run)):
        rj = os.path.join(run, d, "request.json")
        if not os.path.exists(rj):
            continue
        r = json.load(open(rj))
        hdr = {k: ", ".join(v) for k, v in (r.get("header") or {}).items()}
        enc = next((v for k, v in hdr.items() if k.lower() == "content-encoding"), "")
        out.append({
            "n": r.get("seq", d),
            "path": r.get("path"),
            "query": parse_qs(r.get("raw_query") or ""),
            "headers": hdr,
            "content_encoding": enc,
            "file": os.path.join(d, "body.bin"),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--json")
    ap.add_argument("--dump-replay")
    a = ap.parse_args()

    reqs = load_requests(a.run)
    s = {
        "requests": len(reqs),
        "paths": collections.Counter(),
        "content_encoding": collections.Counter(),
        "content_type": collections.Counter(),
        "user_agent": collections.Counter(),
        "auth": collections.Counter(),
        "item_types": collections.Counter(),
        "items_per_envelope": collections.Counter(),
        "sdk_envelope": collections.Counter(),
        "sdk_item": collections.Counter(),
        "session_updates": [],
        "events": [],
        "transactions": [],
        "replay_segments": [],
        "envelope_trace_replay_id": collections.Counter(),
        "other_items": [],
    }
    dumped = False
    for r in reqs:
        s["paths"][r["path"]] += 1
        s["content_encoding"][r["content_encoding"] or "none"] += 1
        h = {k.lower(): v for k, v in r["headers"].items()}
        s["content_type"][h.get("content-type", "-")] += 1
        s["user_agent"][h.get("user-agent", "-")] += 1
        s["auth"]["X-Sentry-Auth header" if "x-sentry-auth" in h else "no X-Sentry-Auth header"] += 1
        s["auth"]["sentry_key query" if "sentry_key" in r["query"] else "no sentry_key query"] += 1
        raw = open(os.path.join(a.run, r["file"]), "rb").read()
        try:
            header, items = parse_envelope(decode_body(raw, r["content_encoding"]))
        except Exception as e:
            s["other_items"].append({"n": r["n"], "error": str(e)})
            continue
        s["auth"]["dsn in envelope header" if "dsn" in header else "no dsn in envelope header"] += 1
        sdk = header.get("sdk") or {}
        s["sdk_envelope"][f"{sdk.get('name')} {sdk.get('version')}"] += 1
        tr = header.get("trace") or {}
        s["envelope_trace_replay_id"]["trace.replay_id present" if tr.get("replay_id") else "no trace.replay_id"] += 1
        s["items_per_envelope"][" + ".join(ih.get("type", "?") for ih, _ in items)] += 1
        for ih, payload in items:
            t = ih.get("type", "?")
            s["item_types"][t] += 1
            if t == "session":
                p = json.loads(payload)
                s["session_updates"].append({k: p.get(k) for k in ("sid", "did", "init", "status", "errors", "seq", "started", "timestamp", "duration", "abnormal_mechanism")} | {"n": r["n"], "attrs": p.get("attrs")})
            elif t in ("event", "transaction"):
                p = json.loads(payload)
                if p.get("sdk"):
                    s["sdk_item"][f"{t}: {p['sdk'].get('name')} {p['sdk'].get('version')}"] += 1
                ctx = p.get("contexts") or {}
                row = {
                    "n": r["n"],
                    "event_id": p.get("event_id"),
                    "level": p.get("level"),
                    "platform": p.get("platform"),
                    "user.id": (p.get("user") or {}).get("id"),
                    "replay_id": (ctx.get("replay") or {}).get("replay_id"),
                    "trace_id": (ctx.get("trace") or {}).get("trace_id"),
                    "release": p.get("release"),
                    "dist": p.get("dist"),
                    "os": f"{(ctx.get('os') or {}).get('name')} {(ctx.get('os') or {}).get('version')}",
                    "device.model": (ctx.get("device") or {}).get("model"),
                }
                if t == "event":
                    vals = ((p.get("exception") or {}).get("values")) or []
                    last = vals[-1] if vals else {}
                    row |= {
                        "exception": f"{last.get('type')}: {str(last.get('value'))[:80]}" if vals else None,
                        "mechanism": (last.get("mechanism") or {}).get("type") if vals else None,
                        "handled": (last.get("mechanism") or {}).get("handled") if vals else None,
                        "message": (p.get("logentry") or {}).get("formatted") or p.get("message"),
                        "breadcrumbs": len((p.get("breadcrumbs") or {}).get("values", []) if isinstance(p.get("breadcrumbs"), dict) else (p.get("breadcrumbs") or [])),
                    }
                    s["events"].append(row)
                else:
                    tctx = ctx.get("trace") or {}
                    spans = p.get("spans") or []
                    http = [sp for sp in spans if str(sp.get("op", "")).startswith("http.client")]
                    row |= {
                        "transaction": p.get("transaction"),
                        "op": tctx.get("op"),
                        "status": tctx.get("status"),
                        "spans": len(spans),
                        "http_spans": [
                            f"{sp.get('description')} -> {(sp.get('data') or {}).get('http.response.status_code')} {sp.get('status')}" for sp in http
                        ],
                        "measurements": sorted((p.get("measurements") or {}).keys()),
                    }
                    s["transactions"].append(row)
            elif t == "replay_video":
                m = Msgpack(payload)
                obj = m.read()
                seg = {"n": r["n"], "payload_bytes": len(payload), "first_byte": f"0x{payload[0]:02x}", "msgpack_layout": m.trace, "keys": list(obj.keys())}
                ev = json.loads(obj.get("replay_event", b"{}"))
                seg |= {k: ev.get(k) for k in ("replay_id", "segment_id", "replay_type", "replay_start_timestamp", "timestamp", "platform")}
                seg["replay_event_keys"] = sorted(ev.keys())
                seg["trace_ids"] = len(ev.get("trace_ids") or [])
                rec = obj.get("replay_recording")
                if rec is not None:
                    hdr, _, arr = rec.partition(b"\n")
                    seg["recording_header"] = hdr.decode(errors="replace")
                    seg["recording_gzip"] = arr[:2] == b"\x1f\x8b"
                    if seg["recording_gzip"]:
                        arr = gzip.decompress(arr)
                    events = json.loads(arr)
                    kinds = collections.Counter()
                    for e in events:
                        d = e.get("data") or {}
                        if e.get("type") == 5:
                            kinds[f"custom:{d.get('tag')}"] += 1
                            if d.get("tag") == "video":
                                seg["video_payload"] = d.get("payload")
                        elif e.get("type") == 3:
                            kinds[f"incremental:source={d.get('source')} type={d.get('type')}"] += 1
                            if d.get("source") == 2 and "touch_example" not in seg:
                                seg["touch_example"] = e
                        else:
                            kinds[f"type={e.get('type')}"] += 1
                    seg["recording_events"] = dict(kinds)
                vid = obj.get("replay_video")
                if vid is not None:
                    seg["video_bytes"] = len(vid)
                    seg["video_ftyp"] = vid[4:12].decode(errors="replace")
                s["replay_segments"].append(seg)
                if a.dump_replay and not dumped and vid is not None:
                    os.makedirs(a.dump_replay, exist_ok=True)
                    open(os.path.join(a.dump_replay, "replay_event.json"), "wb").write(obj["replay_event"])
                    if rec is not None:
                        open(os.path.join(a.dump_replay, "replay_recording.bin"), "wb").write(rec)
                    open(os.path.join(a.dump_replay, "segment.mp4"), "wb").write(vid)
                    dumped = True
            else:
                s["other_items"].append({"n": r["n"], "type": t, "header": ih, "bytes": len(payload), "head": payload[:300].decode(errors="replace")})

    def show(title, v):
        print(f"\n== {title}")
        if isinstance(v, collections.Counter):
            for k, c in v.most_common():
                print(f"  {c:5d}  {k}")
        elif isinstance(v, list):
            for x in v:
                print("  " + json.dumps(x, default=str))
        else:
            print(f"  {v}")

    for k, v in s.items():
        show(k, v)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(s, f, indent=2, default=str)


if __name__ == "__main__":
    main()
