// End-to-end test servers for @ouo11y/browser (Playwright, e2e/*.spec.ts):
//   :4180  the test pages (e2e/pages), the built SDK (dist/) and a tiny API (/api/*) on one origin
//   :4181  a collector stub: OTLP/HTTP JSON on /v1/{traces,logs}, replay chunks (gzip) on
//          /v1/replay/chunks, CORS like the real collector, Basic auth checked. What it received
//          is kept in memory and read back with GET /__captured, cleared with POST /__reset.
//          POST /__fault {status, retryAfter, delayMs} makes every ingest request get that answer
//          (`{}` clears it); /__captured counts them in `faulted`.
//   Pages listed in CSP get a strict Content-Security-Policy with Trusted Types (e2e/csp.spec.ts).
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const PAGE_PORT = Number(process.env.OUO_E2E_PAGE_PORT ?? 4180);
const COLLECTOR_PORT = Number(process.env.OUO_E2E_COLLECTOR_PORT ?? 4181);
const basic = "Basic " + Buffer.from("e2e:pt_e2e").toString("base64");
const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json" };

const empty = () => ({ traces: [], logs: [], replay: [], api: [], rejected: 0, faulted: 0 });
let captured = empty();
let fault = {};
const CSP = {
  "/csp.html": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' http://localhost:${COLLECTOR_PORT}`,
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; "),
};

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    captured.api.push(`${req.method} ${url.pathname}${url.search}`);
    const delay = Number(url.searchParams.get("delay") ?? 0);
    setTimeout(() => {
      res.writeHead(url.searchParams.get("status") ? Number(url.searchParams.get("status")) : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: url.pathname, traceparent: req.headers["traceparent"] ?? null }));
    }, delay);
    return;
  }
  // Server-rendered page stand-in: /ssr.html?traceparent=... writes the meta tag.
  let file = url.pathname.startsWith("/dist/") ? join(root, url.pathname) : join(root, "e2e/pages", url.pathname === "/" ? "app.html" : url.pathname);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "e2e/pages/app.html");
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  if (CSP[url.pathname]) res.setHeader("content-security-policy", CSP[url.pathname]);
  createReadStream(file).pipe(res);
}).listen(PAGE_PORT, () => console.log(`e2e pages http://localhost:${PAGE_PORT}`));

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, content-encoding, x-ouo-session-id, x-ouo-seq");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-max-age", "7200");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/__captured") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(captured));
  }
  if (req.method === "POST" && req.url === "/__reset") {
    captured = empty();
    fault = {};
    return res.writeHead(204).end();
  }
  const parts = [];
  if (req.method === "POST" && req.url === "/__fault") {
    req.on("data", (c) => parts.push(c));
    return req.on("end", () => {
      fault = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
      res.writeHead(204).end();
    });
  }
  if (fault.status) {
    captured.faulted++;
    req.resume();
    return setTimeout(() => {
      res.writeHead(fault.status, fault.retryAfter !== undefined ? { "retry-after": String(fault.retryAfter) } : {}).end();
    }, fault.delayMs ?? 0);
  }
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    if (req.headers["authorization"] !== basic) {
      captured.rejected++;
      return res.writeHead(401).end();
    }
    const raw = Buffer.concat(parts);
    try {
      if (req.url === "/v1/traces" || req.url === "/v1/logs") {
        captured[req.url.slice(4)].push(JSON.parse(raw.toString("utf8")));
      } else if (req.url === "/v1/replay/chunks") {
        const json = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
        captured.replay.push(JSON.parse(json.toString("utf8")));
      } else {
        return res.writeHead(404).end();
      }
    } catch (err) {
      console.error("bad payload", req.url, err);
      return res.writeHead(400).end();
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}).listen(COLLECTOR_PORT, () => console.log(`e2e collector stub http://localhost:${COLLECTOR_PORT}`));
