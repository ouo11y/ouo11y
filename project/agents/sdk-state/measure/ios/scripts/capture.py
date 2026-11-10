#!/usr/bin/env python3
"""Local capture server: answers every request itself and logs one JSON line per request.
    python3 -I capture.py --base 47100 --log requests.jsonl
Ports: base+0 backend (the app's API calls), +1 ouo OTLP, +2 ouo replay, +3 Sentry.
Per request: wall time, port label, method, path, header bytes, body bytes as sent (compressed),
Content-Encoding, the decoded body size, and for Sentry envelopes the item types."""
import argparse, gzip, json, threading, time, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
logf = None
LABELS = ["backend", "ouo-otlp", "ouo-replay", "sentry"]
REPLY = {"backend": b'{"ok":true,"items":[1,2,3]}', "ouo-otlp": b"{}", "ouo-replay": b"{}",
         "sentry": b'{"id":"00000000000000000000000000000000"}'}


def decode(body, enc):
    enc = (enc or "").lower().strip()
    try:
        if enc in ("", "identity"):
            return body
        if enc in ("gzip", "x-gzip"):
            return gzip.decompress(body)
        if enc == "deflate":
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -15)
    except Exception:
        return None
    return None


def envelope_items(raw):
    items = []
    try:
        lines = raw.split(b"\n")
        i = 1
        while i < len(lines):
            if not lines[i].strip():
                i += 1
                continue
            h = json.loads(lines[i])
            items.append(h.get("type"))
            n = h.get("length")
            if n is None:
                i += 2
            else:
                # payload follows the header line; skip by byte length
                rest = b"\n".join(lines[i + 1:])
                rest = rest[n:].lstrip(b"\n")
                lines = [b""] + rest.split(b"\n")
                i = 1
                continue
    except Exception:
        pass
    return items


def make(label):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def handle_any(self):
            te = (self.headers.get("Transfer-Encoding") or "").lower()
            if "chunked" in te:
                body = b""
                while True:
                    size = int(self.rfile.readline().strip().split(b";")[0], 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    body += self.rfile.read(size)
                    self.rfile.readline()
            else:
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            enc = self.headers.get("Content-Encoding")
            dec = decode(body, enc)
            hdr = len(self.requestline) + 2 + sum(len(k) + len(v) + 4 for k, v in self.headers.items()) + 2
            rec = {"t": time.time(), "label": label, "method": self.command, "path": self.path,
                   "header_bytes": hdr, "body_bytes": len(body), "encoding": enc or "",
                   "decoded_bytes": len(dec) if dec is not None else None, "ua": self.headers.get("User-Agent", "")}
            if label == "sentry" and dec is not None and b"envelope" in self.path.encode():
                rec["items"] = envelope_items(dec)
            with lock:
                logf.write(json.dumps(rec) + "\n")
                logf.flush()
            out = REPLY[label]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        do_GET = do_POST = do_PUT = handle_any
    return H


def main():
    global logf
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=int, default=47100)
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    logf = open(a.log, "a")
    servers = []
    for i, label in enumerate(LABELS):
        s = ThreadingHTTPServer(("127.0.0.1", a.base + i), make(label))
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
        servers.append(s)
    print("listening", a.base, flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
