// Serves the built storefront (dist/) with a first-party route to the collector, the way a
// production site avoids ad blockers (docs/first-party-endpoint.md): the app is built with
// VITE_OTLP_ENDPOINT=/otel and the SDK posts to its own origin.
//
//   /otel/v1/replay/*  -> OUO_REPLAY_URL (the collector's replay receiver, port 4319)
//   /otel/*            -> OUO_OTLP_URL   (the collector's OTLP/HTTP receiver, port 4318)
//   anything else      -> dist/, index.html for client routes
//
//   node scripts/serve-first-party.mjs <port>     (run.sh --first-party starts it)
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.argv[2] ?? 4173);
const dist = resolve(new URL("../dist", import.meta.url).pathname);
const otlp = new URL(process.env.OUO_OTLP_URL ?? "http://localhost:4318");
const replay = new URL(process.env.OUO_REPLAY_URL ?? "http://localhost:4319");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".map": "application/json" };

function proxy(req, res, upstream, path) {
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...req.headers, host: upstream.host };
  // The collector's rate limiter keys clients on X-Forwarded-For behind a proxy (OUO_RATELIMIT_CLIENT_KEY).
  headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  const up = send({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.writeHead(502).end());
  req.pipe(up);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/otel/v1/replay/")) return proxy(req, res, replay, url.pathname.slice(5) + url.search);
  if (url.pathname.startsWith("/otel/")) return proxy(req, res, otlp, url.pathname.slice(5) + url.search);
  let file = join(dist, normalize(url.pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`ouo-web on http://localhost:${port}, /otel -> ${otlp.origin} (replay ${replay.origin})`));
