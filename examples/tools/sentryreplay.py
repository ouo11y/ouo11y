#!/usr/bin/env python3
"""Replay recorded Sentry SDK traffic into the Sentry bridge, as if it were sent now.

Input is a `sentrytap` capture directory (collector/tools/sentrytap): one folder per request
holding request.json and body.bin. The golden captures of the bridge live in
collector/receiver/ouosentryreceiver/testdata/golden/<sdk>/journey.

Captured envelopes are weeks old, and Loki refuses samples older than its
reject_old_samples_max_age (168 h), so each envelope is rewritten before it is sent:

  * every timestamp is moved by one offset: by default the journey is replayed in real time
    (each request leaves when it left the SDK, so every envelope is as fresh as it was), with
    `--gap S` pauses are capped at S seconds and the journey is moved to end a minute ago:
    ISO-8601 strings, epoch seconds (1.6e9..2.2e9) and epoch milliseconds (1.6e12..2.2e12),
    inside envelope headers, item payloads, replay events and replay recordings;
  * every 128-bit id (32 hex, or a UUID with dashes, in any case) is mapped to a fresh random
    one, the same new id everywhere in one pass, so sessions, traces, replays and devices still
    link up and a second run never collides with the first (debug ids are kept);
  * replay_video items are msgpack: the replay_event and replay_recording parts are rewritten,
    the mp4 bytes are untouched;
  * item lengths are recomputed and the body is gzip compressed again if it was.

Usage:
  sentryreplay.py --bridge http://localhost:4320 [--capture DIR] [--passes N]
                   [--concurrency C] [--gap S] [--manifest out.json] [--save DIR]

`--passes N --concurrency C` sends N independent copies of the journey (fresh ids each) on C
threads, for load tests; the summary prints the bridge's answer latency (p50/p95/p99/max).
`--save DIR` writes what was sent as a sentrytap capture, the input of
examples/sentry-mobile/scripts/verify-bridge.py. The manifest lists, per pass, the new session ids, trace ids and replay ids, for
deploy/scripts/sentry-demo.sh and sentry-backpressure.sh to query. Standard library only.
"""

import argparse
import concurrent.futures
import datetime as dt
import gzip
import json
import os
import re
import secrets
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CAPTURE = os.path.join(
    HERE, "..", "..", "collector", "receiver", "ouosentryreceiver", "testdata", "golden",
    "ios-rn-8.32.0", "journey")

ISO_RE = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)?$")
ID_RE = re.compile(
    r"(?<![0-9a-fA-F])([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})(?![0-9a-fA-F])")
KEEP_KEYS = {"debug_id", "uuid", "image_uuid", "code_id"}
SEC_LO, SEC_HI = 1.6e9, 2.2e9


class Rewriter:
    """Shifts times by `offset` seconds and remaps ids, consistently within one pass."""

    def __init__(self, offset):
        self.offset = offset
        self.ids = {}
        self.lock = threading.Lock()
        self.sessions, self.traces, self.replays = set(), set(), set()

    def new_id(self, hex32):
        with self.lock:
            if hex32 not in self.ids:
                self.ids[hex32] = secrets.token_hex(16)
            return self.ids[hex32]

    def _id_sub(self, m):
        raw = "".join(m.groups())
        new = self.new_id(raw.lower())
        if raw != raw.lower():
            new = new.upper()
        if "-" in m.group(0):
            new = "-".join([new[:8], new[8:12], new[12:16], new[16:20], new[20:]])
        return new

    def string(self, s):
        m = ISO_RE.match(s)
        if m:
            frac = m.group(2) or ""
            t = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
            micro = int(round(float(frac or "0") * 1e6)) if frac else 0
            t = t + dt.timedelta(microseconds=micro) + dt.timedelta(seconds=self.offset)
            out = t.strftime("%Y-%m-%dT%H:%M:%S")
            if frac:
                digits = len(frac) - 1
                out += "." + f"{t.microsecond:06d}"[:digits].ljust(digits, "0")
            return out + (m.group(3) or "")
        return ID_RE.sub(self._id_sub, s)

    def number(self, v):
        if isinstance(v, bool):
            return v
        if SEC_LO <= v <= SEC_HI:
            return v + self.offset if isinstance(v, float) else int(v + self.offset)
        if SEC_LO * 1000 <= v <= SEC_HI * 1000:
            return v + self.offset * 1000 if isinstance(v, float) else int(v + round(self.offset * 1000))
        return v

    def walk(self, x, key=None):
        if isinstance(x, dict):
            return {k: (v if k in KEEP_KEYS else self.walk(v, k)) for k, v in x.items()}
        if isinstance(x, list):
            return [self.walk(v, key) for v in x]
        if isinstance(x, str):
            out = self.string(x)
            if key == "sid":
                self.sessions.add(out)
            elif key == "trace_id":
                self.traces.add(out)
            elif key == "replay_id":
                self.replays.add(out)
            return out
        if isinstance(x, (int, float)):
            return self.number(x)
        return x

    def json_bytes(self, b):
        return json.dumps(self.walk(json.loads(b)), separators=(",", ":"), ensure_ascii=False).encode()


# ---- msgpack subset: a map of str keys to bin/str values (what Sentry SDKs write) ----

def mp_read_map(b):
    pos = 0

    def take(n):
        nonlocal pos
        v = b[pos:pos + n]
        if len(v) != n:
            raise ValueError("truncated msgpack")
        pos += n
        return v

    def length(tag, small_base=None):
        if tag in (0xc4, 0xd9):
            return take(1)[0]
        if tag in (0xc5, 0xda):
            return struct.unpack(">H", take(2))[0]
        if tag in (0xc6, 0xdb):
            return struct.unpack(">I", take(4))[0]
        if 0xa0 <= tag <= 0xbf:
            return tag - 0xa0
        raise ValueError(f"unsupported msgpack tag 0x{tag:02x}")

    tag = take(1)[0]
    if 0x80 <= tag <= 0x8f:
        n = tag - 0x80
    elif tag == 0xde:
        n = struct.unpack(">H", take(2))[0]
    elif tag == 0xdf:
        n = struct.unpack(">I", take(4))[0]
    else:
        raise ValueError("msgpack payload is not a map")
    out = []
    for _ in range(n):
        k = take(length(take(1)[0])).decode()
        v = take(length(take(1)[0]))
        out.append((k, v))
    return out


def mp_write_map(pairs):
    out = bytearray([0x80 + len(pairs)])
    for k, v in pairs:
        kb = k.encode()
        out += bytes([0xd9, len(kb)]) + kb
        out += b"\xc6" + struct.pack(">I", len(v)) + v
    return bytes(out)


def rewrite_replay(rw, payload):
    pairs = []
    for k, v in mp_read_map(payload):
        if k == "replay_event":
            v = rw.json_bytes(v)
        elif k == "replay_recording":
            head, _, rest = v.partition(b"\n")
            if rest[:2] == b"\x1f\x8b":
                rest = gzip.decompress(rest)
            v = head + b"\n" + rw.json_bytes(rest)
        pairs.append((k, v))
    return mp_write_map(pairs)


def rewrite_envelope(rw, plain):
    header, _, rest = plain.partition(b"\n")
    out = [rw.json_bytes(header)]
    while rest.strip():
        ih_raw, _, rest = rest.partition(b"\n")
        if not ih_raw.strip():
            continue
        ih = json.loads(ih_raw)
        if "length" in ih:
            n = ih["length"]
            payload, rest = rest[:n], rest[n:]
            if rest[:1] == b"\n":
                rest = rest[1:]
        else:
            payload, _, rest = rest.partition(b"\n")
        t = ih.get("type")
        try:
            if t == "replay_video":
                payload = rewrite_replay(rw, payload)
            elif t != "attachment" or ih.get("content_type", "").endswith("json"):
                payload = rw.json_bytes(payload)
        except (ValueError, UnicodeDecodeError):
            pass  # not JSON (binary attachment, unknown item): sent as recorded
        ih["length"] = len(payload)
        out.append(json.dumps(ih, separators=(",", ":")).encode())
        out.append(payload)
    return b"\n".join(out) + b"\n"


def load_capture(path):
    reqs = []
    for name in sorted(os.listdir(path)):
        d = os.path.join(path, name)
        if not os.path.isfile(os.path.join(d, "request.json")):
            continue
        with open(os.path.join(d, "request.json")) as f:
            meta = json.load(f)
        with open(os.path.join(d, "body.bin"), "rb") as f:
            body = f.read()
        meta["_t"] = dt.datetime.fromisoformat(meta["time"].replace("Z", "+00:00")).timestamp()
        reqs.append((meta, body))
    if not reqs:
        sys.exit(f"no captured requests in {path}")
    return reqs


DROP_HEADERS = {"content-length", "host", "accept-encoding", "connection"}


def send(bridge, meta, body, timeout):
    url = bridge.rstrip("/") + meta["path"] + (("?" + meta["raw_query"]) if meta.get("raw_query") else "")
    req = urllib.request.Request(url, data=body, method=meta.get("method", "POST"))
    for k, vs in meta.get("header", {}).items():
        if k.lower() not in DROP_HEADERS:
            req.add_header(k, vs[0])
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        code = f"error: {e}"
    return code, (time.monotonic() - t0) * 1000


def save(args, n, meta, body, offset, code, ms):
    """Writes the request as sent, in sentrytap's layout, so verify-bridge.py can read it."""
    base = args.save if args.passes == 1 else os.path.join(args.save, f"pass-{n:03d}")
    d = os.path.join(base, f"{meta['seq']:06d}")
    os.makedirs(d, exist_ok=True)
    out = {k: v for k, v in meta.items() if k != "_t"}
    out["time"] = dt.datetime.fromtimestamp(meta["_t"] + offset, dt.timezone.utc).isoformat().replace("+00:00", "Z")
    out["body_len"] = len(body)
    with open(os.path.join(d, "request.json"), "w") as f:
        json.dump(out, f, indent=1)
    with open(os.path.join(d, "body.bin"), "wb") as f:
        f.write(body)
    with open(os.path.join(d, "response.json"), "w") as f:
        json.dump({"status": code if isinstance(code, int) else 0, "error": "" if isinstance(code, int) else code,
                   "duration_ms": round(ms, 1)}, f)


def run_pass(args, reqs, n, offset):
    rw = Rewriter(offset)
    results = []
    prev = None
    start = time.monotonic()
    for meta, body in reqs:
        if args.gap < 0:  # real time: each request leaves when it left the SDK, relative to the first
            time.sleep(max(0.0, start + meta["_t"] - reqs[0][0]["_t"] - time.monotonic()))
        elif prev is not None and args.gap > 0:
            time.sleep(min(args.gap, max(0.0, meta["_t"] - prev)))
        prev = meta["_t"]
        gz = body[:2] == b"\x1f\x8b"
        plain = gzip.decompress(body) if gz else body
        new = rewrite_envelope(rw, plain)
        if gz:
            new = gzip.compress(new)
        code, ms = send(args.bridge, meta, new, args.timeout)
        results.append((code, ms))
        if args.save:
            save(args, n, meta, new, offset, code, ms)
        if args.verbose:
            print(f"pass {n} {os.path.basename(str(meta.get('seq', '')))} {code} {ms:.1f} ms", flush=True)
    return {"pass": n, "sessions": sorted(rw.sessions), "traces": sorted(rw.traces),
            "replays": sorted(rw.replays), "results": results}


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bridge", default=os.environ.get("OUO_SENTRY_URL", "http://localhost:4320"))
    ap.add_argument("--capture", default=DEFAULT_CAPTURE)
    ap.add_argument("--passes", type=int, default=1)
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--gap", type=float, default=-1,
                    help="max pause between requests of a pass, seconds; -1 (default) replays in real time")
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--manifest")
    ap.add_argument("--save", help="write the rewritten requests here, in sentrytap's layout (pass-NNN/ per pass when --passes > 1)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    reqs = load_capture(args.capture)
    if args.gap < 0:
        # Real time: every envelope reaches the bridge as fresh as it reached Sentry (Tempo's
        # metrics generator, for one, ignores spans that ended more than 30 s before ingestion).
        offset = time.time() - reqs[0][0]["_t"]
    else:
        # Compressed: the last request of the journey lands a minute ago, the rest keep their spacing.
        offset = time.time() - 60 - reqs[-1][0]["_t"]
    t0 = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        passes = list(ex.map(lambda n: run_pass(args, reqs, n, offset), range(args.passes)))
    wall = time.monotonic() - t0

    lat = [ms for p in passes for _, ms in p["results"]]
    codes = {}
    for p in passes:
        for c, _ in p["results"]:
            codes[str(c)] = codes.get(str(c), 0) + 1
    summary = {"capture": os.path.relpath(args.capture), "bridge": args.bridge, "passes": args.passes,
               "requests": len(lat), "seconds": round(wall, 2), "codes": codes,
               "latency_ms": {"p50": round(pct(lat, 50), 1), "p95": round(pct(lat, 95), 1),
                              "p99": round(pct(lat, 99), 1), "max": round(max(lat), 1)}}
    print(json.dumps(summary))
    if args.manifest:
        with open(args.manifest, "w") as f:
            json.dump({"summary": summary, "passes": [{k: v for k, v in p.items() if k != "results"} for p in passes]}, f, indent=1)
    bad = sum(n for c, n in codes.items() if not c.startswith("2"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
