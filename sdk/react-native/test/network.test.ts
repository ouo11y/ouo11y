import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propagation } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../src/logger";
import { installFetchInstrumentation, isFailedRequest } from "../src/network";
import type { EventEmitter } from "../src/telemetry/events";
import { parseUrl, matchesAny } from "../src/url";

interface Emitted {
  name: string;
  attrs: Record<string, unknown>;
}

function setup(opts: { propagateTo?: Array<RegExp | string>; ignoreUrls?: Array<RegExp | string> } = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const emitted: Emitted[] = [];
  const events = { emit: (name: string, attrs: Record<string, unknown> = {}) => emitted.push({ name, attrs }) } as unknown as EventEmitter;
  const uninstall = installFetchInstrumentation({
    tracer: provider.getTracer("test"),
    events,
    logger: createLogger(false),
    propagateTo: opts.propagateTo ?? [],
    ignoreUrls: opts.ignoreUrls ?? [],
  });
  return { exporter, emitted, uninstall };
}

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
let originalFetch: typeof fetch;
let fetchMock: FetchMock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  propagation.disable();
});

describe("url helpers", () => {
  it("parses absolute URLs without the URL global", () => {
    expect(parseUrl("http://localhost:8082/api/products?delay=2")).toEqual({ scheme: "http", host: "localhost", port: 8082, path: "/api/products" });
    expect(parseUrl("https://api.example.com/")).toEqual({ scheme: "https", host: "api.example.com", port: 443, path: "/" });
    expect(parseUrl("https://user:pw@[::1]:9/x")).toEqual({ scheme: "https", host: "[::1]", port: 9, path: "/x" });
    expect(parseUrl("/relative")).toBeUndefined();
  });
  it("matches prefixes and regexps", () => {
    expect(matchesAny("http://a/b", ["http://a"])).toBe(true);
    expect(matchesAny("http://a/b", [/^http:\/\/b/])).toBe(false);
  });
  it("failed-request rule: 5xx and status 0, not 4xx", () => {
    expect(isFailedRequest(500)).toBe(true);
    expect(isFailedRequest(503)).toBe(true);
    expect(isFailedRequest(0)).toBe(true);
    expect(isFailedRequest(undefined)).toBe(true);
    expect(isFailedRequest(404)).toBe(false);
    expect(isFailedRequest(200)).toBe(false);
  });
});

describe("fetch instrumentation", () => {
  it("creates a CLIENT span with HTTP attributes; a request is not activity", async () => {
    const { exporter, emitted, uninstall } = setup();
    const res = await fetch("http://localhost:8082/api/products", { method: "get" });
    expect(res.status).toBe(200);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("HTTP GET");
    expect(spans[0]!.kind).toBe(2); // CLIENT
    expect(spans[0]!.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.full": "http://localhost:8082/api/products",
      "server.address": "localhost",
      "server.port": 8082,
      "url.path": "/api/products",
      "http.response.status_code": 200,
    });
    expect(emitted).toHaveLength(0);
    uninstall();
    expect(globalThis.fetch).toBe(fetchMock);
  });

  it("injects traceparent and baggage only for propagateTo URLs and keeps caller headers", async () => {
    const { exporter, uninstall } = setup({ propagateTo: [/^http:\/\/localhost:8082/] });
    await fetch("http://localhost:8082/api/cart", { method: "POST", headers: { "content-type": "application/json", "X-User-Id": "u1" }, body: "{}" });
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-User-Id"]).toBe("u1");
    const span = exporter.getFinishedSpans()[0]!;
    expect(headers["traceparent"]).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(init.method).toBe("POST");

    await fetch("http://other.example/api", { headers: { a: "b" } });
    const init2 = fetchMock.mock.calls[1]![1]!;
    expect(init2.headers).toEqual({ a: "b" });
    expect(exporter.getFinishedSpans()).toHaveLength(2);
    uninstall();
  });

  it("merges headers from a Request object and a Headers instance", async () => {
    const { uninstall } = setup({ propagateTo: ["http://localhost:8082"] });
    const req = new Request("http://localhost:8082/api/x", { headers: { accept: "application/json" } });
    await fetch(req, { headers: new Headers({ "x-extra": "1" }) });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/json");
    expect(headers["x-extra"]).toBe("1");
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    uninstall();
  });

  it("emits http.request.failed for 5xx and network failures, not for 4xx or aborts", async () => {
    const { exporter, emitted, uninstall } = setup();
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await fetch("http://localhost:8082/api/checkout?fail=500", { method: "POST" });
    expect(emitted).toEqual([
      {
        name: "http.request.failed",
        attrs: { "http.request.method": "POST", "url.full": "http://localhost:8082/api/checkout?fail=500", "http.response.status_code": 500 },
      },
    ]);
    expect(exporter.getFinishedSpans()[0]!.status.code).toBe(2);
    expect(exporter.getFinishedSpans()[0]!.attributes["ouo.http.failed"]).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response("nf", { status: 404 }));
    await fetch("http://localhost:8082/api/products/nope");
    expect(emitted).toHaveLength(1);

    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await expect(fetch("http://down.local/x")).rejects.toThrow("Network request failed");
    expect(emitted[1]).toEqual({
      name: "http.request.failed",
      attrs: { "http.request.method": "GET", "url.full": "http://down.local/x", "http.response.status_code": 0, "error.type": "TypeError" },
    });
    expect(exporter.getFinishedSpans()[2]!.attributes["error.type"]).toBe("TypeError");

    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abort);
    await expect(fetch("http://localhost:8082/slow")).rejects.toThrow("aborted");
    expect(emitted).toHaveLength(2);
    expect(exporter.getFinishedSpans()).toHaveLength(4);
    uninstall();
  });

  it("ignores configured URLs and exposes the original fetch for the exporter", async () => {
    const { exporter, uninstall } = setup({ ignoreUrls: [/^http:\/\/localhost:4328\//] });
    await fetch("http://localhost:4328/v1/traces", { method: "POST" });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect((globalThis.fetch as unknown as { __original: unknown }).__original).toBe(fetchMock);
    uninstall();
  });
});
