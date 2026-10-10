/**
 * Live transport check against a real HTTP server on 127.0.0.1:18081 (no mocked fetch):
 * the SDK's OTLP exporters and the replay uploader must reach rum-api's three ingest
 * routes with the project token header (ADR-0007). This is the closest we can get to the
 * new rum-api without running it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { initRUM, type RUM } from "../src/index";

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const PORT = 18081;
const TOKEN = "pt_dev_demo_0000000000000000";
const seen: Seen[] = [];
let server: Server;
let rum: RUM & { _uninstall?: () => Promise<void> };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts);
      const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      seen.push({ method: req.method ?? "", path: new URL(req.url ?? "/", "http://x").pathname, headers: req.headers, body });
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      if (req.url?.startsWith("/api/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (req.headers["x-ouo-project-token"] !== TOKEN) return res.writeHead(401).end();
      if (req.url === "/v1/replay/chunks") return res.writeHead(202).end();
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve());
  });
  localStorage.clear();
  rum = initRUM({
    endpoint: `http://127.0.0.1:${PORT}`,
    projectToken: TOKEN,
    service: { name: "stub-check", version: "0.0.1", environment: "test" },
    tracing: { propagateTo: [new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/api/`)] },
    replay: { enabled: true, flushIntervalMs: 200 },
    debug: false,
  });
});

afterAll(async () => {
  await rum._uninstall?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("ingest over a real socket (stub rum-api on :18081)", () => {
  it("traces, logs and replay chunks arrive on the rum-api routes with X-Ouo-Project-Token", async () => {
    await fetch(`http://127.0.0.1:${PORT}/api/ping`); // one CLIENT span
    rum.addEvent("stub.check", { n: 1 }); // one log record
    await wait(700); // fetch span closes after 300 ms; rrweb lazy chunk + 200 ms replay flush
    await rum.flush();
    await wait(100);

    const byPath = (p: string) => seen.filter((s) => s.method === "POST" && s.path === p);
    const traces = byPath("/ingest/otlp/v1/traces");
    const logs = byPath("/ingest/otlp/v1/logs");
    const chunks = byPath("/v1/replay/chunks");
    expect(traces.length, JSON.stringify(seen.map((s) => `${s.method} ${s.path}`))).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);

    for (const r of [...traces, ...logs, ...chunks]) {
      expect(r.headers["x-ouo-project-token"], r.path).toBe(TOKEN);
      expect(r.headers["content-type"]).toBe("application/json");
    }
    // Payload shapes: OTLP JSON and the replay chunk envelope.
    expect(JSON.parse(traces[0]!.body)).toHaveProperty("resourceSpans");
    expect(JSON.parse(logs.find((l) => l.body.includes("stub.check"))!.body)).toHaveProperty("resourceLogs");
    const chunk = JSON.parse(chunks[0]!.body) as { session_id: string; seq: number; events: unknown[] };
    expect(chunk.session_id).toBe(rum.session.id());
    expect(chunks[0]!.headers["x-ouo-session-id"]).toBe(chunk.session_id);
    expect(chunks[0]!.headers["x-ouo-seq"]).toBe(String(chunk.seq));
    expect(chunks[0]!.headers["content-encoding"]).toBe("gzip");

    // Nothing hit the pre-0.2.0 direct paths, and the app request itself carried trace context.
    expect(seen.some((s) => s.path === "/v1/traces" || s.path === "/v1/logs")).toBe(false);
    const app = seen.find((s) => s.path === "/api/ping")!;
    expect(app.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(app.headers["x-ouo-project-token"]).toBeUndefined(); // the token is only for ingest routes
  });
});
