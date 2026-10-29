// One Node process, two localhost ports:
//  - page:   serves the test page, app.js and each cell's SDK bundle (dist/<cell>/), logs every JS file served
//  - intake: answers every SDK request with 200 (+ CORS) and records count and bytes per SDK, split
//            into telemetry / replay; also the page's own API (/api/*) and PostHog's lazy scripts.
// Control (runner only, on the intake port): GET /__bench/reset, GET /__bench/stats.
// Prints {"page":<port>,"intake":<port>} on its first stdout line.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { gzipSync, gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync, constants } from "node:zlib";
import { dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const posthogDist = join(here, "node_modules/posthog-js/dist");

let log = [];      // intake requests
let served = [];   // JS files served by the page port (and PostHog statics by the intake)
const gz9Cache = new Map();

const gz9 = (buf) => gzipSync(buf, { level: constants.Z_BEST_COMPRESSION }).length;

function tryInflate(buf) {
  for (const f of [gunzipSync, inflateSync, inflateRawSync]) {
    try { return f(buf); } catch { /* next */ }
  }
  return null;
}

// Bytes after removing transport compression: HTTP Content-Encoding first, then the SDK's own
// compression where it is a known framing (Sentry envelope items, Datadog multipart segment,
// PostHog gzip-js body). Best effort: unknown framings count as-is.
function decodedSize(body, headers, url) {
  let b = body;
  const enc = (headers["content-encoding"] || "").toLowerCase();
  try {
    if (enc === "gzip") b = gunzipSync(b);
    else if (enc === "deflate") b = tryInflate(b) ?? b;
    else if (enc === "br") b = brotliDecompressSync(b);
  } catch { /* keep raw */ }
  if (url.includes("compression=gzip") || (b[0] === 0x1f && b[1] === 0x8b)) {
    const d = tryInflate(b); if (d) b = d;
  }
  const ct = headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    // Datadog replay: parts; the "segment" part is zlib-deflated JSON.
    const boundary = /boundary=([^;]+)/.exec(ct)?.[1];
    if (boundary) {
      let total = 0;
      const parts = b.toString("latin1").split("--" + boundary);
      for (const p of parts) {
        const i = p.indexOf("\r\n\r\n");
        if (i < 0) continue;
        const raw = Buffer.from(p.slice(i + 4).replace(/\r\n$/, ""), "latin1");
        total += (tryInflate(raw) ?? raw).length;
      }
      return total;
    }
  }
  if (url.includes("/envelope/")) {
    // Sentry envelope: header line, then (item header line, payload) pairs; replay_recording payload is
    // "{segment header}\n" + zlib-deflated rrweb events.
    let total = 0, pos = b.indexOf(0x0a);
    total += pos + 1;
    while (pos >= 0 && pos < b.length - 1) {
      const hEnd = b.indexOf(0x0a, pos + 1);
      if (hEnd < 0) break;
      let item; try { item = JSON.parse(b.subarray(pos + 1, hEnd).toString()); } catch { break; }
      total += hEnd - pos;
      const len = item.length ?? (b.indexOf(0x0a, hEnd + 1) < 0 ? b.length - hEnd - 1 : b.indexOf(0x0a, hEnd + 1) - hEnd - 1);
      const payload = b.subarray(hEnd + 1, hEnd + 1 + len);
      if (item.type === "replay_recording") {
        const nl = payload.indexOf(0x0a);
        const inner = payload.subarray(nl + 1);
        total += nl + 1 + (tryInflate(inner) ?? inner).length;
      } else total += payload.length;
      pos = hEnd + 1 + len;
      if (b[pos] !== 0x0a) pos = pos - 1; // items without trailing newline
    }
    return total;
  }
  return b.length;
}

// Which SDK and which kind of data a request is.
function classify(url, body, headers) {
  const p = url.split("?")[0];
  if (p.startsWith("/api/")) return ["app", "app"];
  if (p.startsWith("/ouo/")) return ["ouo", p.includes("/replay/") ? "replay" : "telemetry"];
  if (p.startsWith("/sentry/")) {
    const head = body.subarray(0, 4096).toString("latin1");
    return ["sentry", /"type":"replay_(event|recording)"/.test(head) ? "replay" : "telemetry"];
  }
  if (p.startsWith("/dd")) {
    const fwd = decodeURIComponent(/ddforward=([^&]+)/.exec(url)?.[1] ?? "");
    return ["datadog", fwd.includes("/replay") ? "replay" : "telemetry"];
  }
  if (p.startsWith("/ph/")) {
    if (p.startsWith("/ph/static/") || p.endsWith(".js")) return ["posthog", "script"];
    if (p.startsWith("/ph/s")) return ["posthog", "replay"];
    // PostHog batches $snapshot events to /s/; anything else is analytics, flags or config
    return ["posthog", "telemetry"];
  }
  if (p.startsWith("/faro/")) return ["faro", "telemetry"];
  if (p.startsWith("/splunk/")) return ["splunk", p.includes("rumreplay") ? "replay" : "telemetry"];
  return ["other", "other"];
}

// Remote config PostHog fetches before it starts recording (a fresh project with recording on).
const POSTHOG_CONFIG = {
  sessionRecording: { endpoint: "/s/" },
  supportedCompression: ["gzip", "gzip-js"],
  autocapture_opt_out: false,
  capturePerformance: false,
  autocaptureExceptions: false,
  heatmaps: false,
  surveys: false,
  siteApps: [],
  defaultIdentifiedOnly: true,
};

const cors = (req) => ({
  "access-control-allow-origin": req.headers.origin || "*",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": req.headers["access-control-request-headers"] || "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-max-age": "600",
  "timing-allow-origin": "*",
});

async function sendFile(res, path, extra = {}) {
  const buf = await readFile(path);
  const type = { ".js": "text/javascript", ".html": "text/html", ".json": "application/json" }[extname(path)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(buf);
  return buf;
}

function recordJs(url, buf) {
  if (!gz9Cache.has(url)) gz9Cache.set(url, gz9(buf));
  served.push({ url, bytes: buf.length, gz9: gz9Cache.get(url) });
}

const page = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/blank") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>blank</title>"); return; }
    if (url.pathname === "/app.js") { await sendFile(res, join(here, "page/app.js")); return; }
    const m = /^\/c\/([a-z0-9-]+)\/(.*)$/.exec(url.pathname);
    if (m) {
      const [, cell, rest] = m;
      if (rest.endsWith(".js")) {
        const file = normalize(join(here, "dist", cell, rest));
        if (!file.startsWith(join(here, "dist"))) throw new Error("path");
        recordJs(`/c/${cell}/${rest}`, await sendFile(res, file));
        return;
      }
      await sendFile(res, join(here, "page/index.html")); // every route of the SPA
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(404); res.end(String(e.message));
  }
});

const intake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const url = req.url;
    const headers = cors(req);
    if (url.startsWith("/__bench/")) {
      if (url.startsWith("/__bench/reset")) { log = []; served = []; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(url.startsWith("/__bench/stats") ? JSON.stringify({ log, served }) : "{}");
      return;
    }
    const body = Buffer.concat(chunks);
    const t = Date.now();
    if (req.method === "OPTIONS") {
      const [sdk] = classify(url, body, req.headers);
      log.push({ t, sdk, kind: "preflight", method: "OPTIONS", url: url.slice(0, 120), wire: 0, decoded: 0, headerBytes: 0 });
      res.writeHead(204, headers); res.end(); return;
    }
    const [sdk, kind] = classify(url, body, req.headers);
    const headerBytes = req.rawHeaders.reduce((n, h) => n + h.length + 2, 0) + req.method.length + url.length + 12;
    // PostHog lazily loads its recorder and remote config from api_host.
    if (sdk === "posthog" && kind === "script") {
      const name = /\/static\/(?:[0-9.]+\/)?([a-z0-9-]+)\.js/.exec(url)?.[1];
      try {
        if (name) { recordJs(`/ph/static/${name}.js`, await sendFile(res, join(posthogDist, `${name}.js`), headers)); }
        else if (/\/array\/[^/]+\/config\.js/.test(url)) {
          const js = `(window._POSTHOG_REMOTE_CONFIG=window._POSTHOG_REMOTE_CONFIG||{})["phc_bench"]={config:${JSON.stringify(POSTHOG_CONFIG)},siteApps:[]};`;
          res.writeHead(200, { "content-type": "text/javascript", ...headers }); res.end(js);
          recordJs("/ph/array/config.js", Buffer.from(js));
        } else { res.writeHead(404, headers); res.end(); }
      } catch { res.writeHead(404, headers); res.end(); }
      log.push({ t, sdk, kind: "script", method: req.method, url: url.slice(0, 120), wire: 0, decoded: 0, headerBytes });
      return;
    }
    log.push({ t, sdk, kind, method: req.method, url: url.slice(0, 120), wire: body.length, decoded: decodedSize(body, req.headers, url), headerBytes });
    let out = "{}";
    if (sdk === "posthog" && /\/(flags|decide)\//.test(url)) out = JSON.stringify({ ...POSTHOG_CONFIG, flags: {}, featureFlags: {}, errorsWhileComputingFlags: false });
    else if (sdk === "posthog" && /\/array\/[^/]+\/config/.test(url)) out = JSON.stringify(POSTHOG_CONFIG);
    else if (sdk === "posthog") out = JSON.stringify({ status: 1 });
    else if (sdk === "app") out = JSON.stringify({ id: url.split("?")[1] ?? "", items: Array.from({ length: 5 }, (_, i) => ({ i, name: `item ${i}` })) });
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(out);
  });
});

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const ports = { page: await listen(page), intake: await listen(intake) };
console.log(JSON.stringify(ports));
