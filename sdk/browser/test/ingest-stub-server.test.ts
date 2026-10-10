/**
 * Live transport check against real HTTP servers (no mocked fetch): the SDK's OTLP exporters
 * and the replay uploader must reach the collector's OTLP receiver (`/v1/traces`, `/v1/logs`,
 * stub on 127.0.0.1:18081) and the replay receiver (`/v1/replay/chunks`, stub on 127.0.0.1:18082)
 * with `Authorization: Basic base64(projectId:projectToken)` (ADR-0007). This is the closest
 * we can get to `ouo-collector` without running it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { initRUM, type RUM } from "../src/index";

interface Seen {
  port: number;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const OTLP_PORT = 18081;
const REPLAY_PORT = 18082;
const PROJECT_ID = "demo";
const TOKEN = "pt_dev_demo_0000000000000000";
const BASIC = "Basic " + Buffer.from(`${PROJECT_ID}:${TOKEN}`).toString("base64");
const seen: Seen[] = [];
const servers: Server[] = [];
let rum: RUM & { _uninstall?: () => Promise<void> };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listen(port: number, replay: boolean): Promise<Server> {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts);
      const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      seen.push({ port, method: req.method ?? "", path: new URL(req.url ?? "/", "http://x").pathname, headers: req.headers, body });
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      if (req.url?.startsWith("/api/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      // basicauth extension behaviour: missing or wrong credential is 401.
      if (req.headers["authorization"] !== BASIC) return res.writeHead(401).end();
      if (replay) return res.writeHead(req.url === "/v1/replay/chunks" ? 202 : 404).end();
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

beforeAll(async () => {
  servers.push(await listen(OTLP_PORT, false), await listen(REPLAY_PORT, true));
  localStorage.clear();
  rum = initRUM({
    endpoint: `http://127.0.0.1:${OTLP_PORT}`,
    replayEndpoint: `http://127.0.0.1:${REPLAY_PORT}`, // explicit: the stub cannot bind 4318/4319 next to a running stack
    projectId: PROJECT_ID,
    projectToken: TOKEN,
    service: { name: "stub-check", version: "0.0.1", environment: "test" },
    tracing: { propagateTo: [new RegExp(`^http://127\\.0\\.0\\.1:${OTLP_PORT}/api/`)] },
    replay: { enabled: true, flushIntervalMs: 200 },
    debug: false,
  });
});

afterAll(async () => {
  await rum._uninstall?.();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe("ingest over a real socket (collector stub on :18081, replay stub on :18082)", () => {
  it("traces, logs and replay chunks arrive on the collector routes with the Basic credential", async () => {
    await fetch(`http://127.0.0.1:${OTLP_PORT}/api/ping`); // one CLIENT span
    rum.addEvent("stub.check", { n: 1 }); // one log record
    await wait(700); // fetch span closes after 300 ms; rrweb lazy chunk + 200 ms replay flush
    await rum.flush();
    await wait(100);

    const byPath = (port: number, p: string) => seen.filter((s) => s.port === port && s.method === "POST" && s.path === p);
    const traces = byPath(OTLP_PORT, "/v1/traces");
    const logs = byPath(OTLP_PORT, "/v1/logs");
    const chunks = byPath(REPLAY_PORT, "/v1/replay/chunks");
    expect(traces.length, JSON.stringify(seen.map((s) => `${s.method} :${s.port}${s.path}`))).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);

    for (const r of [...traces, ...logs, ...chunks]) {
      expect(r.headers["authorization"], r.path).toBe(BASIC);
      expect(r.headers["x-ouo-project-token"], r.path).toBeUndefined();
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

    // Nothing hit the revision-1 rum-api gateway paths, replay never went to the OTLP port,
    // and the app request itself carried trace context but no credential.
    expect(seen.some((s) => s.path.startsWith("/ingest/"))).toBe(false);
    expect(seen.some((s) => s.port === OTLP_PORT && s.path.startsWith("/v1/replay"))).toBe(false);
    const app = seen.find((s) => s.path === "/api/ping")!;
    expect(app.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(app.headers["authorization"]).toBeUndefined(); // the credential is only for ingest routes
  });
});
