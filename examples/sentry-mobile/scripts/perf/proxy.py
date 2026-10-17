#!/usr/bin/env python3
"""Counting HTTP forwarder: every request the app makes goes through it, one JSON line per request.

    python3 -I proxy.py --log requests.jsonl \
        --route sentry:4720:4520 --route otlp:4718:4518 --route replay:4719:4519 --route backend:4781:8581

Each --route is label:listen_port:upstream_port (both on 127.0.0.1). Bytes are counted at the HTTP
level as the app sent and received them: request line + headers + body, status line + headers +
body (no TLS, no TCP/IP overhead; the simulator talks plain HTTP to localhost). The run harness
cuts the log by time per run.
"""
import argparse
import http.client
import socket
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
logf = None


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
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("transfer-encoding", "connection", "host")}
            headers["Content-Length"] = str(len(body))
            status, resp_body, resp_headers = 502, b"", []
            try:
                c = http.client.HTTPConnection("127.0.0.1", upstream_port, timeout=60)
                c.request(self.command, self.path, body=body, headers=headers)
                r = c.getresponse()
                status, resp_body, resp_headers = r.status, r.read(), r.getheaders()
                c.close()
            except Exception as e:  # upstream down: the app sees a 502
                resp_body = str(e).encode()
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
            rec = {
                "t": t, "label": label, "method": self.command, "path": self.path,
                "status": status, "req_bytes": req_bytes, "req_body": len(body), "resp_bytes": sent,
                "ms": round((time.time() - t) * 1000, 1),
            }
            with lock:
                logf.write(json.dumps(rec) + "\n")
                logf.flush()

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

    return H


class V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def main():
    global logf
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--route", action="append", required=True)
    a = ap.parse_args()
    logf = open(a.log, "a")
    servers = []
    for r in a.route:
        label, lp, up = r.split(":")
        # "localhost" in the app may resolve to ::1 or 127.0.0.1: listen on both loopbacks only.
        for host, cls in (("127.0.0.1", ThreadingHTTPServer), ("::1", V6Server)):
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
