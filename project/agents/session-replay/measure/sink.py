#!/usr/bin/env python3
"""Local sink for the recorder comparison: answers every request itself.
    python3 -I sink.py --base 47300 --out <dir>
Ports: base+0 OTLP/HTTP (200), base+1 replay receiver (202). One JSON line per request in
<dir>/requests.jsonl (wall time, port, path, body bytes as sent, decoded bytes); every replay body
is saved decoded to <dir>/chunks/<n>.json for frame extraction."""
import argparse, gzip, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
state = {"n": 0}


def make(label, out):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            enc = (self.headers.get("Content-Encoding") or "").lower()
            dec = gzip.decompress(body) if enc == "gzip" else body
            rec = {"t": time.time(), "port": label, "path": self.path, "body_bytes": len(body),
                   "decoded_bytes": len(dec), "header_bytes": sum(len(k) + len(v) + 4 for k, v in self.headers.items())}
            with lock:
                if label == "replay":
                    state["n"] += 1
                    name = "%05d.json" % state["n"]
                    with open(os.path.join(out, "chunks", name), "wb") as f:
                        f.write(dec)
                    rec["file"] = name
                with open(os.path.join(out, "requests.jsonl"), "a") as f:
                    f.write(json.dumps(rec) + "\n")
            reply = b'{"accepted":1}' if label == "replay" else b"{}"
            self.send_response(202 if label == "replay" else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=int, default=47300)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(os.path.join(a.out, "chunks"), exist_ok=True)
    servers = [ThreadingHTTPServer(("127.0.0.1", a.base + i), make(l, a.out)) for i, l in enumerate(["otlp", "replay"])]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    servers[0].serve_forever()


if __name__ == "__main__":
    main()
