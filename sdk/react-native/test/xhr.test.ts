import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propagation } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../src/logger";
import { installFetchInstrumentation, installXhrInstrumentation } from "../src/network";
import type { EventEmitter } from "../src/telemetry/events";

/** Minimal XMLHttpRequest: records what reaches the "network" and lets the test answer. */
class FakeXHR {
  static sent: FakeXHR[] = [];
  status = 0;
  method = "";
  url = "";
  headers: Array<[string, string]> = [];
  private listeners: Record<string, Array<() => void>> = {};
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers.push([name, value]);
  }
  send(_body?: unknown): void {
    FakeXHR.sent.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  header(name: string): string[] {
    return this.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
  }
  respond(status: number): void {
    this.status = status;
    this.fire("load");
    this.fire("loadend");
  }
  networkError(): void {
    this.status = 0;
    this.fire("error");
    this.fire("loadend");
  }
  abort(): void {
    this.status = 0;
    this.fire("abort");
    this.fire("loadend");
  }
  private fire(type: string): void {
    for (const l of this.listeners[type] ?? []) l();
  }
}

const pristine = { ...Object.getOwnPropertyDescriptors(FakeXHR.prototype) };

function setup(opts: { propagateTo?: Array<RegExp | string>; ignoreUrls?: Array<RegExp | string> } = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const emitted: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const events = { emit: (name: string, attrs: Record<string, unknown> = {}) => emitted.push({ name, attrs }) } as unknown as EventEmitter;
  const onActivity = vi.fn();
  const networkOptions = {
    tracer: provider.getTracer("test"),
    events,
    logger: createLogger(false),
    propagateTo: opts.propagateTo ?? [],
    ignoreUrls: opts.ignoreUrls ?? [],
    onActivity,
  };
  const uninstall = installXhrInstrumentation(networkOptions);
  return { exporter, emitted, onActivity, uninstall, networkOptions };
}

function request(method: string, url: string, headers: Record<string, string> = {}): FakeXHR {
  const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
  xhr.open(method, url);
  for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
  xhr.send();
  return xhr;
}

const g = globalThis as { XMLHttpRequest?: unknown };
let previousXhr: unknown;

beforeEach(() => {
  previousXhr = g.XMLHttpRequest;
  g.XMLHttpRequest = FakeXHR;
  FakeXHR.sent = [];
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));
});

afterEach(() => {
  Object.defineProperties(FakeXHR.prototype, pristine);
  delete (FakeXHR.prototype as { __ouo?: true }).__ouo;
  g.XMLHttpRequest = previousXhr;
  propagation.disable();
});

describe("XMLHttpRequest instrumentation (axios and other XHR clients)", () => {
  it("creates a CLIENT span per request with the fetch wrapper's attributes", () => {
    const { exporter, emitted, onActivity, uninstall } = setup();
    const xhr = request("get", "http://localhost:8084/api/cart");
    expect(exporter.getFinishedSpans()).toHaveLength(0); // ends on loadend
    xhr.respond(200);
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe("HTTP GET");
    expect(span!.kind).toBe(2);
    expect(span!.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.full": "http://localhost:8084/api/cart",
      "server.address": "localhost",
      "server.port": 8084,
      "url.path": "/api/cart",
      "http.response.status_code": 200,
    });
    expect(span!.status.code).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(onActivity).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("applies the failed-request rule: 5xx and network errors, not 4xx or aborts", () => {
    const { exporter, emitted, uninstall } = setup();
    request("POST", "http://api/checkout").respond(500);
    request("GET", "http://api/missing").respond(404);
    request("GET", "http://api/down").networkError();
    request("GET", "http://api/cancelled").abort();
    expect(emitted.map((e) => [e.attrs["url.full"], e.attrs["http.response.status_code"], e.attrs["error.type"]])).toEqual([
      ["http://api/checkout", 500, undefined],
      ["http://api/down", 0, "NetworkError"],
    ]);
    const byUrl = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.attributes["url.full"], s]));
    expect(byUrl["http://api/checkout"]!.status.code).toBe(2);
    expect(byUrl["http://api/missing"]!.status.code).toBe(0);
    expect(byUrl["http://api/cancelled"]!.attributes["error.type"]).toBe("AbortError");
    uninstall();
  });

  it("adds traceparent and baggage only to propagateTo URLs", () => {
    const { exporter, uninstall } = setup({ propagateTo: [/^http:\/\/localhost:8084/] });
    const ours = request("GET", "http://localhost:8084/api/products");
    const third = request("GET", "https://photon.komoot.io/api?q=berlin");
    ours.respond(200);
    third.respond(200);
    expect(ours.header("traceparent")).toHaveLength(1);
    const span = exporter.getFinishedSpans().find((s) => s.attributes["url.full"] === "http://localhost:8084/api/products")!;
    expect(ours.header("traceparent")[0]).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(third.header("traceparent")).toHaveLength(0);
    uninstall();
  });

  it("never adds a second traceparent when another SDK set one first (Sentry with propagateTraceparent)", () => {
    const { uninstall } = setup({ propagateTo: [/^http:\/\/api/] });
    // Like the SDK's SessionPropagator: baggage always carries the session.
    propagation.disable();
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [
          new W3CTraceContextPropagator(),
          { inject: (_c, carrier, setter) => setter.set(carrier, "baggage", "session.id=s1"), extract: (c) => c, fields: () => ["baggage"] },
        ],
      }),
    );
    // Another SDK patching XHR after ouo: its send sets headers, then calls ouo's send.
    const ouoSend = FakeXHR.prototype.send;
    FakeXHR.prototype.send = function sentrySend(this: FakeXHR, body?: unknown) {
      this.setRequestHeader("sentry-trace", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-1");
      this.setRequestHeader("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
      this.setRequestHeader("baggage", "sentry-trace_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      return ouoSend.call(this, body);
    };
    const xhr = request("GET", "http://api/products");
    expect(xhr.header("traceparent")).toEqual(["00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"]);
    // XHR joins repeated headers: "sentry-trace_id=..., session.id=s1" is one valid baggage list.
    expect(xhr.header("baggage")).toEqual(["sentry-trace_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session.id=s1"]);
    uninstall();
  });

  it("skips ignored URLs (the SDK's own uploads)", () => {
    const { exporter, onActivity, uninstall } = setup({ ignoreUrls: [/^http:\/\/collector\/v1\/traces/] });
    request("POST", "http://collector/v1/traces").respond(200);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(onActivity).not.toHaveBeenCalled();
    uninstall();
  });

  it("traces a fetch once: React Native's fetch runs its XHR inside ouo's fetch wrapper", async () => {
    const { exporter, networkOptions, uninstall } = setup({ propagateTo: [/^http:\/\/api/] });
    const previousFetch = globalThis.fetch;
    // whatwg-fetch: the XHR is created, opened and sent synchronously inside fetch().
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const xhr = new FakeXHR();
        xhr.open(init?.method ?? "GET", input);
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) xhr.setRequestHeader(k, v);
        xhr.send();
        xhr.respond(200);
        resolve(new Response("{}", { status: 200 }));
      })) as typeof fetch;
    const uninstallFetch = installFetchInstrumentation(networkOptions);
    try {
      await fetch("http://api/products");
      expect(exporter.getFinishedSpans()).toHaveLength(1);
      expect(FakeXHR.sent[0]!.header("traceparent")).toHaveLength(1);
      // A plain XHR afterwards is traced again.
      request("GET", "http://api/cart").respond(200);
      expect(exporter.getFinishedSpans()).toHaveLength(2);
    } finally {
      uninstallFetch();
      globalThis.fetch = previousFetch;
      uninstall();
    }
  });

  it("uninstall restores the prototype", () => {
    const { uninstall } = setup();
    expect(FakeXHR.prototype.send).not.toBe(pristine.send!.value);
    uninstall();
    expect(FakeXHR.prototype.send).toBe(pristine.send!.value);
    expect(FakeXHR.prototype.open).toBe(pristine.open!.value);
    expect(FakeXHR.prototype.setRequestHeader).toBe(pristine.setRequestHeader!.value);
  });
});
