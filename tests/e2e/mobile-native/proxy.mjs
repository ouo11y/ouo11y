// Forwards every request to the collector and logs one JSON line per request (path, method,
// content-encoding, status), so the suite sees what the SDK put on the wire (C11.2).
// Usage: node proxy.mjs <port> <collector base URL> <log file>
import { appendFileSync } from "node:fs";
import http from "node:http";

const [port, target, logFile] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      delete headers.host;
      try {
        const r = await fetch(new URL(req.url, target), { method: req.method, headers, body: body.length ? body : undefined });
        const out = Buffer.from(await r.arrayBuffer());
        appendFileSync(logFile, JSON.stringify({ ts: Date.now(), path: req.url, method: req.method, encoding: req.headers["content-encoding"] ?? null, status: r.status }) + "\n");
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(out);
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  })
  .listen(Number(port), "127.0.0.1");
