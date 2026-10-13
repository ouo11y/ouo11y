#!/usr/bin/env python3
"""Throwaway Sentry ingest recorder for the sentry-demo app (stdlib only).

Listens on 127.0.0.1:4400 (the default DSN host), logs every request and saves raw bodies:

    captures/<run>/requests.jsonl     one JSON line per request (method, path, query, headers, size)
    captures/<run>/NNNN-<type>.bin    the raw body bytes exactly as received (still gzip if sent so)

Answers 200 {"id": "<envelope event_id or empty>"} like Sentry, so the SDK drops the envelope
from its disk cache. Analyse a run with scripts/analyze.py captures/<run>.

    python3 scripts/recorder.py [--port 4400] [--out captures/<run>]
"""
import argparse
import datetime as dt
import gzip
import json
import os
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

lock = threading.Lock()
counter = 0


def decode_body(raw: bytes, encoding: str) -> bytes:
    enc = (encoding or "").lower()
    if enc == "gzip" or raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    if enc == "deflate":
        return zlib.decompress(raw)
    return raw


def item_types(body: bytes) -> tuple[str, list[str]]:
    """Return (event_id, [item types]) from a decoded envelope; tolerant of junk."""
    lines = body.split(b"\n", 1)
    try:
        header = json.loads(lines[0])
    except Exception:
        return "", ["<malformed>"]
    rest = lines[1] if len(lines) > 1 else b""
    types: list[str] = []
    pos = 0
    while pos < len(rest):
        nl = rest.find(b"\n", pos)
        if nl == -1:
            nl = len(rest)
        hline = rest[pos:nl].strip()
        if not hline:
            pos = nl + 1
            continue
        try:
            ih = json.loads(hline)
        except Exception:
            types.append("<bad-item-header>")
            break
        types.append(ih.get("type", "?"))
        pos = nl + 1
        if "length" in ih:
            pos += int(ih["length"]) + 1
        else:
            nl2 = rest.find(b"\n", pos)
            pos = len(rest) if nl2 == -1 else nl2 + 1
    return header.get("event_id", "") or "", types


class Handler(BaseHTTPRequestHandler):
    out_dir = "captures"

    def log_message(self, fmt, *args):  # silence default logging
        pass

    def _handle(self):
        global counter
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        u = urlsplit(self.path)
        enc = self.headers.get("Content-Encoding", "")
        event_id, types = "", []
        try:
            event_id, types = item_types(decode_body(raw, enc)) if raw else ("", [])
        except Exception as e:  # keep recording even if decoding fails
            types = [f"<decode-error {e}>"]
        with lock:
            counter += 1
            n = counter
        tag = "-".join(sorted(set(types)))[:60] or "empty"
        fname = f"{n:04d}-{tag}.bin"
        with open(os.path.join(self.out_dir, fname), "wb") as f:
            f.write(raw)
        rec = {
            "n": n,
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"),
            "method": self.command,
            "path": u.path,
            "query": parse_qs(u.query),
            "headers": {k: v for k, v in self.headers.items()},
            "body_size": len(raw),
            "content_encoding": enc,
            "item_types": types,
            "file": fname,
        }
        with lock, open(os.path.join(self.out_dir, "requests.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"{rec['ts']} #{n} {self.command} {u.path} {len(raw)}B enc={enc or '-'} items={types}", flush=True)
        body = json.dumps({"id": event_id}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = _handle
    do_PUT = _handle
    do_GET = _handle


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=4400)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--out", default=None)
    a = p.parse_args()
    out = a.out or os.path.join(os.path.dirname(__file__), "..", "captures", dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(out, exist_ok=True)
    Handler.out_dir = out
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"recording on http://{a.host}:{a.port} into {os.path.abspath(out)}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
