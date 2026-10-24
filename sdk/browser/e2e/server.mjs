// End-to-end test servers for @ouo11y/browser (Playwright, e2e/*.spec.ts):
//   :4180  the test pages (e2e/pages), the built SDK (dist/) and a tiny API (/api/*) on one origin,
//          plus /otel/* : a first-party proxy route to the collector stub (README, "First-party
//          endpoint"); like a proxy holding the credential it adds Authorization when absent (beacons)
//   :4181  a collector stub: OTLP/HTTP JSON on /v1/{traces,logs}, replay chunks (gzip) on
//          /v1/replay/chunks, CORS like the real collector, Basic auth checked. What it received
//          is kept in memory and read back with GET /__captured, cleared with POST /__reset.
//          POST /__fault {status, retryAfter, delayMs, count, paths} answers ingest requests on
//          `paths` (default all) with that status and/or after that delay (a slow collector), the
//          next `count` of them or every one until `{}` clears it; /__captured counts them in
//          `faulted` and lists every ingest request in `requests` (path, status, encoding, bytes, time).
//   Pages listed in CSP get a strict Content-Security-Policy with Trusted Types (e2e/csp.spec.ts).
import { createServer, request } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const PAGE_PORT = Number(process.env.OUO_E2E_PAGE_PORT ?? 4180);
const COLLECTOR_PORT = Number(process.env.OUO_E2E_COLLECTOR_PORT ?? PAGE_PORT + 1);
const basic = "Basic " + Buffer.from("e2e:pt_e2e").toString("base64");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

const empty = () => ({ traces: [], logs: [], replay: [], api: [], rejected: 0, faulted: 0, requests: [] });
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
  if (url.pathname.startsWith("/otel/")) {
    const headers = { ...req.headers, host: `localhost:${COLLECTOR_PORT}` };
    headers["authorization"] ??= basic;
    const upstream = request({ host: "localhost", port: COLLECTOR_PORT, method: req.method, path: url.pathname.slice("/otel".length), headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
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
  res.setHeader("access-control-expose-headers", "Retry-After");
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
  if (req.method === "POST" && req.url === "/__fault") {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      fault = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
      res.writeHead(204).end();
    });
    return;
  }
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const active = (fault.status || fault.delayMs) && fault.count !== 0 && (!fault.paths || fault.paths.includes(req.url)) ? { ...fault } : null;
    if (active) {
      captured.faulted++;
      if (fault.count !== undefined) fault.count--;
    }
    const record = { path: req.url, at: Date.now(), encoding: req.headers["content-encoding"] ?? null, bytes: Buffer.concat(parts).length, status: 200 };
    captured.requests.push(record);
    setTimeout(() => answer(active, record), active?.delayMs ?? 0);
  });
  const answer = (f, record) => {
    if (f?.status) {
      record.status = f.status;
      return res.writeHead(f.status, f.retryAfter !== undefined ? { "retry-after": String(f.retryAfter) } : {}).end();
    }
    if (req.headers["authorization"] !== basic) {
      captured.rejected++;
      return res.writeHead(401).end();
    }
    const raw = Buffer.concat(parts);
    try {
      // Like the collector's confighttp: gzip or identity on every route.
      const json = (req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
      if (req.url === "/v1/traces" || req.url === "/v1/logs") {
        captured[req.url.slice(4)].push(JSON.parse(json));
      } else if (req.url === "/v1/replay/chunks") {
        captured.replay.push(JSON.parse(json));
      } else {
        return res.writeHead(404).end();
      }
    } catch (err) {
      console.error("bad payload", req.url, err);
      return res.writeHead(400).end();
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  };
}).listen(COLLECTOR_PORT, () => console.log(`e2e collector stub http://localhost:${COLLECTOR_PORT}`));
