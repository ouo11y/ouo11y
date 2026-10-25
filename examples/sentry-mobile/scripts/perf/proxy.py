#!/usr/bin/env python3
"""Counting HTTP forwarder: every request the app makes goes through it, one JSON line per request.

    python3 -I proxy.py --log requests.jsonl \
        --route sentry:4720:4520 --route otlp:4718:4518 --route replay:4719:4519 --route backend:4781:8581 \
        [--lan] [--offline-flag <file>] [--sink]

Each --route is label:listen_port:upstream_port (upstream on 127.0.0.1). Bytes are counted at the
HTTP level as the app sent and received them: request line + headers + body, status line + headers +
body (no TLS, no TCP/IP overhead: plain HTTP). The run harness cuts the log by time per run.

Per request it also records the body decoded from its Content-Encoding (`req_body_decoded`: the
uncompressed size) and, for Sentry envelopes, the item types (`items`), so replay uploads
(`replay_video`, `replay_recording`) can be counted apart from errors, transactions and logs.

--lan listens on every interface instead of the loopbacks only (a phone reaches the Mac by its LAN
IP). --offline-flag: while that file exists, requests on every route except `backend` get no
response: the connection is closed after the request is read, as on a dead network (the offline
benchmark cell). --sink answers every route except `backend` in the proxy itself (200, a minimal
body) instead of forwarding: CI runners have no Docker for a stack; the network numbers stay the
SDKs' own (the request side is what is measured), only response latency and bodies differ.
"""
import argparse
import gzip
import http.client
import json
import os
import socket
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
logf = None
offline_flag = None
sink = False
SINK_BODY = {"sentry": b'{"id":"00000000000000000000000000000000"}', "otlp": b"{}", "replay": b"{}"}


def decode(body, encoding):
    """The body as the SDK produced it before compression, or None when it cannot be decoded."""
    enc = (encoding or "").lower().strip()
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
        if enc == "br":
            return None  # no brotli in the standard library; neither SDK sends it today
    except Exception:
        return None
    return None


def envelope_items(body):
    """Sentry envelope: header line, then (item header line, payload) pairs. Returns [(type, bytes)]."""
    items = []
    try:
        lines = body.split(b"\n", 1)
        rest = lines[1] if len(lines) > 1 else b""
        while rest:
            if rest.startswith(b"\n"):
                rest = rest[1:]
                continue
            nl = rest.find(b"\n")
            head = json.loads(rest[: nl if nl >= 0 else len(rest)])
            rest = rest[nl + 1 :] if nl >= 0 else b""
            if "length" in head:
                n = int(head["length"])
                payload, rest = rest[:n], rest[n:]
            else:
                nl = rest.find(b"\n")
                payload, rest = (rest[:nl], rest[nl + 1 :]) if nl >= 0 else (rest, b"")
            items.append((str(head.get("type", "?")), len(payload)))
            if head.get("type") == "client_report":
                # What the SDK dropped and why (rate limits, queue overflow, sample rate): small JSON.
                try:
                    items.append(("client_report_body", json.loads(payload)))
                except ValueError:
                    pass
    except Exception:
        pass
    return items


def forward(port, method, path, body, headers):
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        out = r.status, r.read(), r.getheaders()
        c.close()
        return out
    except Exception as e:  # upstream down: the app sees a 502
        return 502, str(e).encode(), []


def make_handler(label, upstream_port):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _body(self):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                body, wire = b"", 0
                while True:
                    line = self.rfile.readline()
                    wire += len(line)
                    size = int(line.split(b";")[0].strip(), 16)
                    if size == 0:
                        wire += len(self.rfile.readline())
                        return body, wire
                    chunk = self.rfile.read(size + 2)
                    wire += len(chunk)
                    body += chunk[:-2]
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            return body, len(body)

        def _handle(self):
            t = time.time()
            body, body_wire = self._body()
            req_bytes = len(self.raw_requestline) + len(self.headers.as_bytes()) + body_wire
            decoded = decode(body, self.headers.get("Content-Encoding"))
            rec = {"t": t, "label": label, "method": self.command, "path": self.path, "req_bytes": req_bytes,
                   "req_body": len(body), "req_body_decoded": len(decoded) if decoded is not None else None,
                   "encoding": self.headers.get("Content-Encoding") or ""}
            if "/envelope" in self.path and decoded is not None:
                rec["items"] = envelope_items(decoded)
            if offline_flag and label != "backend" and os.path.exists(offline_flag):
                rec.update(status=0, resp_bytes=0, ms=0, offline=True)
                with lock:
                    logf.write(json.dumps(rec) + "\n")
                    logf.flush()
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("transfer-encoding", "connection", "host")}
            headers["Content-Length"] = str(len(body))
            if sink and label != "backend":
                status, resp_body, resp_headers = 200, SINK_BODY.get(label, b"{}"), [("Content-Type", "application/json")]
            else:
                status, resp_body, resp_headers = forward(upstream_port, self.command, self.path, body, headers)
            self.send_response(status)
            sent = len(f"HTTP/1.1 {status} {self.responses.get(status, ('',))[0]}\r\n")
            for k, v in resp_headers:
                if k.lower() in ("transfer-encoding", "connection", "content-length", "date", "server"):
                    continue
                self.send_header(k, v)
                sent += len(k) + len(v) + 4
            self.send_header("Content-Length", str(len(resp_body)))
            sent += len(str(len(resp_body))) + 18 + 2
            self.end_headers()
            self.wfile.write(resp_body)
            sent += len(resp_body)
            rec.update(status=status, resp_bytes=sent, ms=round((time.time() - t) * 1000, 1))
            with lock:
                logf.write(json.dumps(rec) + "\n")
                logf.flush()

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

    return H


class V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def main():
    global logf, offline_flag, sink
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--route", action="append", required=True)
    ap.add_argument("--lan", action="store_true", help="listen on every interface (device runs)")
    ap.add_argument("--offline-flag", help="while this file exists, SDK routes get no response")
    ap.add_argument("--sink", action="store_true", help="answer every route except backend in the proxy")
    a = ap.parse_args()
    sink = a.sink
    logf = open(a.log, "a")
    offline_flag = a.offline_flag
    servers = []
    for r in a.route:
        label, lp, up = r.split(":")
        # "localhost" in the app may resolve to ::1 or 127.0.0.1: listen on both loopbacks, or on
        # every interface for a phone on the LAN.
        hosts = (("0.0.0.0", ThreadingHTTPServer),) if a.lan else (("127.0.0.1", ThreadingHTTPServer), ("::1", V6Server))
        for host, cls in hosts:
            s = cls((host, int(lp)), make_handler(label, int(up)))
            s.daemon_threads = True
            threading.Thread(target=s.serve_forever, daemon=True).start()
            servers.append(s)
        print(f"{label}: localhost:{lp} -> 127.0.0.1:{up}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
