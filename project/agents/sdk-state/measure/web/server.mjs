// Static files, a fake API, and a fake collector that answers 200 (ouo OTLP, replay) or 200 (Sentry
// envelopes) and records the size of every ingest request body exactly as it arrived on the wire.
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
let saved = 0;
export function startServer(port = 0) {
  const log = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const p = url.pathname;
      const ingest = p.startsWith("/v1/") || p.startsWith("/api/1/");
      if (ingest) {
        const replay = p.includes("replay") || (p.startsWith("/api/1/") && body.includes('"type":"replay_'));
        log.push({ t: Date.now(), path: p, replay, bytes: body.length, enc: req.headers["content-encoding"] || "", ct: req.headers["content-type"] || "", headerBytes: Object.entries(req.headers).reduce((s, [k, v]) => s + k.length + String(v).length + 4, 0) });
        if (process.env.SAVE_BODIES) { mkdirSync(process.env.SAVE_BODIES, { recursive: true }); writeFileSync(`${process.env.SAVE_BODIES}/${String(saved++).padStart(4, "0")}${p.replace(/\//g, "_")}${req.headers["content-encoding"] === "gzip" ? ".gz" : ""}`, body); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(p.startsWith("/api/1/") ? "{}" : "{}");
      }
      if (p === "/api/items") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(Array.from({ length: 50 }, (_, i) => `Fetched item ${i} ${Date.now()}`))); }
      if (p === "/api/checkout") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
      let f = p.startsWith("/dist/") ? "." + p : "./page.html";
      if (!existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html", "cache-control": "no-store" });
      res.end(readFileSync(f));
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ srv, log, port: srv.address().port })));
}
