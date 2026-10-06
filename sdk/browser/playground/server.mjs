// Throwaway verification servers (not part of the SDK):
//   :4173  static server for playground/ and dist/
//   :8090  replay chunk stub: accepts POST /v1/replay/chunks (gzip or plain JSON),
//          validates the envelope and writes <dir>/<session>/<seq>.json
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = process.env.OUO_CHUNK_DIR ?? resolve(root, "playground", ".chunks");
mkdirSync(outDir, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".css": "text/css" };
createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  let file = join(root, path === "/" ? "playground/index.html" : path.startsWith("/dist/") ? path : `playground${path}`);
  // SPA-style fallback so /cart reloads the playground.
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "playground/index.html");
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(res);
}).listen(4173, () => console.log("static http://localhost:4173"));

const cors = (res, req) => {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
  res.setHeader("access-control-allow-headers", "content-type, content-encoding, x-ouo-session-id, x-ouo-seq");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
};
createServer((req, res) => {
  cors(res, req);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method !== "POST" || req.url !== "/v1/replay/chunks") return res.writeHead(404).end();
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts);
    try {
      const json = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      const chunk = JSON.parse(json.toString("utf8"));
      const ok = typeof chunk.session_id === "string" && Number.isInteger(chunk.seq) && Array.isArray(chunk.events) &&
        chunk.events.every((e) => Number.isInteger(e.type) && typeof e.timestamp === "number") &&
        chunk.session_id === req.headers["x-ouo-session-id"] && String(chunk.seq) === req.headers["x-ouo-seq"];
      if (!ok) throw new Error("invalid chunk envelope");
      const dir = join(outDir, chunk.session_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${String(chunk.seq).padStart(6, "0")}.json`), JSON.stringify(chunk));
      const types = chunk.events.map((e) => e.type);
      console.log(`chunk session=${chunk.session_id} seq=${chunk.seq} wire=${raw.length}B json=${json.length}B events=${chunk.events.length} types=[${[...new Set(types)].join(",")}] gzip=${req.headers["content-encoding"] === "gzip"} keepalive=${req.headers["content-encoding"] !== "gzip"}`);
      res.writeHead(202).end();
    } catch (err) {
      console.log("bad chunk:", err.message);
      res.writeHead(400).end(String(err.message));
    }
  });
}).listen(8090, () => console.log("replay stub http://localhost:8090 ->", outDir));
