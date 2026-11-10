#!/usr/bin/env python3
"""Capture server for the Step 5 Android harness. Answers 200 to everything and logs one JSON line per
request: host time, port, method, path, body bytes as sent (on the wire, before any gunzip), header bytes
(request line + headers) and content-encoding. Port 8711 is the app's own API, 8712 the telemetry sink
(Sentry DSN http://pub@10.0.2.2:8712/1, ouo replay endpoint http://10.0.2.2:8712)."""
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[1], "a", buffering=1)
lock = threading.Lock()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = b""
        if n:
            body = self.rfile.read(n)
        elif self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                size = int(self.rfile.readline().strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline(); break
                body += self.rfile.read(size); self.rfile.readline()
        hdr = len(self.requestline) + 2 + sum(len(k) + len(v) + 4 for k, v in self.headers.items()) + 2
        rec = {"t": time.time(), "port": self.server.server_address[1], "method": self.command, "path": self.path.split("?")[0],
               "body": len(body), "hdr": hdr, "enc": self.headers.get("Content-Encoding", ""), "ua": self.headers.get("User-Agent", "")[:60]}
        with lock:
            LOG.write(json.dumps(rec) + "\n")
        out = b'{"id":"00000000000000000000000000000000"}' if self.server.server_address[1] == 8712 else b'{"items":[1,2,3]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    do_GET = do_POST = do_PUT = handle_any

for port in (8711, 8712):
    s = ThreadingHTTPServer(("0.0.0.0", port), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
print("listening 8711 8712", flush=True)
while True:
    time.sleep(3600)
