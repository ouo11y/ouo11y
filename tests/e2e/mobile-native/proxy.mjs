// Forwards every request to the collector and logs one JSON line per request (path, method,
// content-encoding, status, the hash of the uncompressed body), so the suite sees what the SDK put
// on the wire (C11.2) and which requests it sent again (C11.3).
// `POST /__reject` arms the faults of C11.3: from then on the first OTLP body is answered 500
// every time it is sent and the second 503 once, without forwarding them.
// Usage: node proxy.mjs <port> <collector base URL> <log file>
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";
import { gunzipSync } from "node:zlib";

const [port, target, logFile] = process.argv.slice(2);
const faults = { armed: false, poison: undefined, flaky: undefined, flakyAnswered: false };

function hash(body, encoding) {
  if (!body.length) return null;
  try {
    return createHash("sha256").update(encoding === "gzip" ? gunzipSync(body) : body).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function fault(h) {
  if (!faults.armed || !h) return undefined;
  faults.poison ??= h;
  if (h === faults.poison) return 500;
  faults.flaky ??= h;
  if (h === faults.flaky && !faults.flakyAnswered) {
    faults.flakyAnswered = true;
    return 503;
  }
  return undefined;
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (req.url === "/__reject") {
        faults.armed = true;
        res.writeHead(204);
        res.end();
        return;
      }
      const body = Buffer.concat(chunks);
      const encoding = req.headers["content-encoding"] ?? null;
      const line = { ts: Date.now(), path: req.url, method: req.method, encoding, body: hash(body, encoding) };
      const injected = /\/v1\/(logs|traces)$/.test(req.url) ? fault(line.body) : undefined;
      if (injected) {
        appendFileSync(logFile, JSON.stringify({ ...line, status: injected, injected: true }) + "\n");
        res.writeHead(injected, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: injected, message: "injected by the suite's proxy" }));
        return;
      }
      const headers = { ...req.headers };
      delete headers.host;
      try {
        const r = await fetch(new URL(req.url, target), { method: req.method, headers, body: body.length ? body : undefined });
        const out = Buffer.from(await r.arrayBuffer());
        appendFileSync(logFile, JSON.stringify({ ...line, status: r.status }) + "\n");
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(out);
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  })
  .listen(Number(port), "127.0.0.1");
