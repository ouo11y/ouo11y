/**
 * Drives the public API inside jsdom with a stubbed fetch and asserts the
 * outbound OTLP/HTTP JSON payloads (spec test case 7 and the event catalogue).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initRUM, type RUM } from "../src/index";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const captured: Captured[] = [];
const responses: Array<{ match: RegExp; status: number }> = [];

function decodeBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  // instanceof fails across realms (jsdom vs Node), so duck-type buffers.
  const isBuffer = ArrayBuffer.isView(body) || Object.prototype.toString.call(body) === "[object ArrayBuffer]";
  const text = typeof body === "string" ? body : isBuffer ? new TextDecoder().decode(body as ArrayBuffer) : String(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  }
  return out;
}

type Attr = { key: string; value: Record<string, unknown> };
function attrs(list: Attr[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of list ?? []) {
    const v = a.value;
    out[a.key] = v["stringValue"] ?? v["intValue"] ?? v["doubleValue"] ?? v["boolValue"] ?? v;
  }
  return out;
}

function logRecords() {
  const out: Array<{ eventName: string; attributes: Record<string, unknown>; resource: Record<string, unknown> }> = [];
  for (const c of captured.filter((c) => c.url === "http://localhost:8090/v1/logs")) {
    const body = c.body as { resourceLogs: Array<{ resource: { attributes: Attr[] }; scopeLogs: Array<{ logRecords: Array<{ eventName: string; attributes: Attr[] }> }> }> };
    for (const rl of body.resourceLogs) {
      for (const sl of rl.scopeLogs) {
        for (const lr of sl.logRecords) out.push({ eventName: lr.eventName, attributes: attrs(lr.attributes), resource: attrs(rl.resource.attributes) });
      }
    }
  }
  return out;
}

function spans() {
  const out: Array<{ name: string; attributes: Record<string, unknown>; traceId: string; spanId: string }> = [];
  for (const c of captured.filter((c) => c.url === "http://localhost:8090/v1/traces")) {
    const body = c.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; attributes: Attr[]; traceId: string; spanId: string }> }> }> };
    for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ ...s, attributes: attrs(s.attributes) });
  }
  return out;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROJECT_ID = "web-store";
const PROJECT_TOKEN = "pt_test_integration_0000";
const BASIC = "Basic " + Buffer.from(`${PROJECT_ID}:${PROJECT_TOKEN}`).toString("base64");

let rum: RUM & { _uninstall?: () => Promise<void> };

beforeAll(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = headersToRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    captured.push({ url, headers, body: decodeBody(init?.body) });
    const rule = responses.find((r) => r.match.test(url));
    if (rule && rule.status === 0) throw new TypeError("Failed to fetch");
    return new Response("{}", { status: rule?.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  rum = initRUM({
    endpoint: "http://localhost:8090/", // not :4318, so replay derives to the same base (ADR-0007 section 6)
    projectId: PROJECT_ID,
    projectToken: PROJECT_TOKEN,
    service: { name: "web-store", version: "1.4.2", environment: "test" },
    tracing: { propagateTo: [/^http:\/\/localhost:8082/] },
    replay: { enabled: true, maskAllInputs: true, flushIntervalMs: 200 },
    session: { inactivityTimeoutMs: 60_000, maxDurationMs: 3_600_000 },
    debug: false,
  });
});

afterAll(async () => {
  await rum._uninstall?.();
});

describe("initRUM end to end (jsdom, stubbed fetch)", () => {
  it("emits session.start with identifiers and resource attributes", async () => {
    await rum.flush();
    const start = logRecords().find((r) => r.eventName === "session.start");
    expect(start).toBeDefined();
    expect(start!.attributes["event.name"]).toBe("session.start");
    expect(start!.attributes["session.id"]).toBe(rum.session.id());
    expect(start!.attributes["user.id"]).toBe(rum.session.userId());
    expect(start!.attributes["ouo.user.anonymous"]).toBe(true);
    expect(start!.attributes["ouo.platform"]).toBe("web");
    expect(start!.attributes["service.version"]).toBe("1.4.2");
    expect(start!.attributes["ouo.session.started_at"]).toBeDefined();
    expect(start!.resource["service.name"]).toBe("web-store");
    expect(start!.resource["service.version"]).toBe("1.4.2");
    expect(start!.resource["deployment.environment.name"]).toBe("test");
    expect(start!.resource["ouo.platform"]).toBe("web");
    expect(start!.resource["telemetry.sdk.name"]).toBe("opentelemetry");
    expect(start!.resource["ouo.sdk.version"]).toBeDefined();
    expect(start!.resource["user_agent.original"]).toBeDefined();
    expect(JSON.parse(localStorage.getItem("ouo.session")!).id).toBe(rum.session.id());
  });

  it("emits an initial navigation event", async () => {
    await rum.flush();
    const nav = logRecords().find((r) => r.eventName === "navigation");
    expect(nav).toBeDefined();
    expect(nav!.attributes["url.path"]).toBe(location.pathname);
    expect(nav!.attributes["ouo.navigation.kind"]).toBe("load");
  });

  it("fetch to a propagateTo origin carries traceparent and baggage with the session id, and the span carries session.id (case 7)", async () => {
    await fetch("http://localhost:8082/api/products");
    await wait(400);
    await rum.flush();
    const req = captured.find((c) => c.url === "http://localhost:8082/api/products");
    expect(req).toBeDefined();
    expect(req!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const baggage = req!.headers["baggage"]!;
    expect(baggage).toContain(`session.id=${rum.session.id()}`);
    expect(baggage).toContain(`user.id=${rum.session.userId()}`);
    expect(baggage).toContain("ouo.platform=web");
    const span = spans().find((s) => s.attributes["url.full"] === "http://localhost:8082/api/products");
    expect(span).toBeDefined();
    expect(span!.attributes["session.id"]).toBe(rum.session.id());
    expect(span!.attributes["user.id"]).toBe(rum.session.userId());
    expect(span!.attributes["ouo.platform"]).toBe("web");
    expect(span!.attributes["service.version"]).toBe("1.4.2");
    expect(span!.attributes["http.request.method"]).toBe("GET");
    expect(span!.attributes["http.response.status_code"]).toBe(200);
    expect(req!.headers["traceparent"]).toContain(span!.traceId);
  });

  it("does not propagate headers to origins outside propagateTo", async () => {
    await fetch("http://third-party.example/api");
    const req = captured.find((c) => c.url === "http://third-party.example/api");
    expect(req!.headers["traceparent"]).toBeUndefined();
    expect(req!.headers["baggage"]).toBeUndefined();
  });

  it("5xx and network failures emit http.request.failed, 4xx does not", async () => {
    responses.push({ match: /\/api\/checkout\?fail=1/, status: 500 });
    responses.push({ match: /\/api\/missing/, status: 404 });
    responses.push({ match: /\/api\/down/, status: 0 });
    await fetch("http://localhost:8082/api/checkout?fail=1", { method: "POST" });
    await fetch("http://localhost:8082/api/missing");
    await fetch("http://localhost:8082/api/down").catch(() => undefined);
    await wait(400);
    await rum.flush();
    const failed = logRecords().filter((r) => r.eventName === "http.request.failed");
    const urls = failed.map((f) => f.attributes["url.full"]);
    expect(urls).toContain("http://localhost:8082/api/checkout?fail=1");
    expect(urls).toContain("http://localhost:8082/api/down");
    expect(urls).not.toContain("http://localhost:8082/api/missing");
    const f500 = failed.find((f) => f.attributes["url.full"] === "http://localhost:8082/api/checkout?fail=1")!;
    expect(f500.attributes["http.request.method"]).toBe("POST");
    expect(f500.attributes["http.response.status_code"]).toBe(500);
    expect(f500.attributes["session.id"]).toBe(rum.session.id());
  });

  it("uncaught errors are fatal, captureError and console.error are not", async () => {
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("uncaught boom"), message: "uncaught boom" }));
    rum.captureError(new Error("handled boom"), { "cart.id": "c-1" });
    console.error("console boom", new Error("inner"));
    await rum.flush();
    const ex = logRecords().filter((r) => r.eventName === "exception");
    const uncaught = ex.find((e) => e.attributes["exception.message"] === "uncaught boom")!;
    expect(uncaught.attributes["exception.type"]).toBe("RangeError");
    expect(uncaught.attributes["ouo.exception.fatal"]).toBe(true);
    expect(uncaught.attributes["ouo.exception.handled"]).toBe(false);
    expect(uncaught.attributes["session.id"]).toBe(rum.session.id());
    const handled = ex.find((e) => e.attributes["exception.message"] === "handled boom")!;
    expect(handled.attributes["ouo.exception.fatal"]).toBe(false);
    expect(handled.attributes["ouo.exception.handled"]).toBe(true);
    expect(handled.attributes["cart.id"]).toBe("c-1");
    const consoleEx = ex.find((e) => String(e.attributes["exception.message"]).startsWith("console boom"))!;
    expect(consoleEx.attributes["ouo.exception.kind"]).toBe("console");
    expect(consoleEx.attributes["ouo.exception.fatal"]).toBe(false);
  });

  it("unhandled rejections are fatal", async () => {
    const ev = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(ev, "reason", { value: new Error("rejected boom") });
    window.dispatchEvent(ev);
    await rum.flush();
    const e = logRecords().find((r) => r.attributes["exception.message"] === "rejected boom")!;
    expect(e.attributes["ouo.exception.fatal"]).toBe(true);
    expect(e.attributes["ouo.exception.kind"]).toBe("unhandledrejection");
  });

  it("route changes emit navigation events", async () => {
    history.pushState({}, "", "/cart");
    await rum.flush();
    const nav = logRecords().find((r) => r.eventName === "navigation" && r.attributes["url.path"] === "/cart")!;
    expect(nav.attributes["ouo.navigation.from"]).toBe("/");
    expect(nav.attributes["ouo.navigation.kind"]).toBe("push");
  });

  it("custom events and setUser", async () => {
    rum.setUser({ id: "user-42" });
    rum.addEvent("cart.added", { sku: "sku-1", qty: 2 });
    await rum.flush();
    const ev = logRecords().find((r) => r.eventName === "cart.added")!;
    expect(ev.attributes["sku"]).toBe("sku-1");
    expect(ev.attributes["qty"]).toBe(2);
    expect(ev.attributes["user.id"]).toBe("user-42");
    expect(ev.attributes["ouo.user.anonymous"]).toBe(false);
    expect(rum.session.userId()).toBe("user-42");
  });

  it("every OTLP export goes to the collector /v1/{traces,logs} with the Basic credential, and ingest requests are not traced (ADR-0007)", async () => {
    await rum.flush();
    const traces = captured.filter((c) => c.url === "http://localhost:8090/v1/traces");
    const logs = captured.filter((c) => c.url === "http://localhost:8090/v1/logs");
    expect(traces.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    for (const c of [...traces, ...logs]) {
      expect(c.headers["authorization"], c.url).toBe(BASIC);
      expect(c.headers["x-ouo-project-token"]).toBeUndefined();
      expect(c.headers["content-type"]).toBe("application/json");
      expect(c.url).not.toContain(PROJECT_TOKEN);
    }
    // Nothing went to the revision-1 rum-api gateway paths.
    expect(captured.some((c) => c.url.includes("/ingest/otlp/"))).toBe(false);
    // The export requests themselves never become spans (ignoreUrls + fetch.__original).
    for (const s of spans()) expect(String(s.attributes["url.full"] ?? "")).not.toContain("localhost:8090");
  });

  it("every log record and span carries session.id (case 7)", () => {
    const id = rum.session.id();
    const records = logRecords();
    expect(records.length).toBeGreaterThan(5);
    for (const r of records) expect(r.attributes["session.id"], r.eventName).toBe(id);
    const all = spans();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(s.attributes["session.id"], s.name).toBe(id);
  });

  it("records a replay and uploads gzip chunks with the session id and seq", async () => {
    // The lazy rrweb chunk loads (slow under load), then the 200 ms flush fires.
    const replayChunks = () => captured.filter((c) => c.url === "http://localhost:8090/v1/replay/chunks");
    await vi.waitFor(
      async () => {
        await rum.flush();
        expect(replayChunks().length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 200 },
    );
    const chunks = replayChunks();
    expect(chunks[0]!.headers["x-ouo-session-id"]).toBe(rum.session.id());
    expect(chunks[0]!.headers["x-ouo-seq"]).toBe("0");
    expect(chunks[0]!.headers["content-encoding"]).toBe("gzip");
    expect(chunks[0]!.headers["authorization"]).toBe(BASIC);
    expect(chunks[0]!.headers["x-ouo-project-token"]).toBeUndefined();
    expect(rum.replay.isRecording()).toBe(true);
    rum.replay.pause();
    expect(rum.replay.isRecording()).toBe(false);
  });
});
