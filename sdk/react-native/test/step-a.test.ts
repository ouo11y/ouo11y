/**
 * ADR-0021 step A, part 1: configuration that never throws (CFG-1..3), the spec's API surface
 * (API-1, API-3, API-6, LIF-4, LIF-5, REL-5), `beforeSend` (CFG-4), drop counting (ERR-7, ERR-8),
 * no global registration (REL-4), truncation at source (REC-8), the spec version (VER-2).
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORD_ATTRIBUTE_BYTES, MAX_STACKTRACE_BYTES, MAX_STRING_BYTES, appAttributes, truncateAttributes } from "../src/attributes";
import { MAX_SESSION_DURATION_MS, MIN_TIMEOUT_MS, normalizeOptions } from "../src/config";
import { DROP_EVENT, DROP_REPORT_INTERVAL_MS, DropCounter } from "../src/drops";
import * as sdk from "../src/index";
import { initRUM, SPEC_VERSION, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";
import type { RUMOptions } from "../src/types";
import { nativeReplay, resetNative } from "./mocks/expo-modules-core";
import { attr, BACKEND, baseOptions, ENDPOINT, g, installErrorUtils, installFetchStub, sleep, type Captured } from "./support/otlp";

let originalFetch: typeof fetch;
const TOKEN = baseOptions().projectToken;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  installErrorUtils();
  resetNative();
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  globalThis.fetch = originalFetch;
  delete g.ErrorUtils;
  delete g.__ouoSessionProcessState;
  trace.disable();
  context.disable();
  propagation.disable();
});

async function start(extra: Partial<RUMOptions> = {}, storage = new MemoryAsyncStorage()): Promise<{ rum: RUMInternal; captured: Captured; storage: MemoryAsyncStorage }> {
  const captured = installFetchStub();
  const rum = initRUM({ ...baseOptions(storage), ...extra } as RUMOptions) as RUMInternal;
  await rum.ready;
  return { rum, captured, storage };
}

const drops = (c: Captured) =>
  c.byName(DROP_EVENT).map((l) => `${attr(l.attributes, "ouo.sdk.drop.signal")}/${attr(l.attributes, "ouo.sdk.drop.reason")}=${attr(l.attributes, "ouo.sdk.drop.count")}`);

describe("configuration never throws (CFG-1, CFG-2, CFG-3)", () => {
  const base = baseOptions();

  it("no config, with a diagnostic, when a required option is missing or invalid", () => {
    const bad: Array<[string, unknown]> = [
      ["options", undefined],
      ["options", "x"],
      ["endpoint", { ...base, endpoint: undefined }],
      ["endpoint", { ...base, endpoint: "" }],
      ["endpoint", { ...base, endpoint: "ftp://x" }],
      ["endpoint", { ...base, endpoint: 4318 }],
      ["projectId", { ...base, projectId: undefined }],
      ["projectId", { ...base, projectId: "a:b" }],
      ["projectToken", { ...base, projectToken: "  " }],
      ["projectToken", { ...base, projectToken: 7 }],
      ["service.name", { ...base, service: undefined }],
      ["service.name", { ...base, service: { name: "", version: "1", environment: "e" } }],
      ["service.name", { ...base, service: { name: 5 } }],
    ];
    for (const [what, options] of bad) {
      const { config, diagnostics } = normalizeOptions(options);
      expect(config, what).toBeUndefined();
      expect(diagnostics.join(" "), what).toContain(what === "projectToken" ? "projectId" : what);
      expect(diagnostics.join(" ")).toContain("no-op");
      // CFG-3: a diagnostic never quotes a credential.
      expect(diagnostics.join(" ")).not.toContain(TOKEN.slice(0, 6));
    }
  });

  it("invalid values fall back to defaults and out-of-range values are clamped, each with a diagnostic", () => {
    const { config, diagnostics } = normalizeOptions({
      ...base,
      service: { name: "app" },
      session: { inactivityTimeoutMs: 5, backgroundTimeoutMs: 30_000, maxDurationMs: 7 * 24 * 3600 * 1000, sampleRate: 3 },
      diagnostics: { selfDisableThreshold: -1 },
      transport: { shutdownDeadlineMs: "soon" },
      beforeSend: "not a function",
      otel: { registerGlobal: "yes" },
      debug: "yes",
    });
    expect(config).toMatchObject({
      service: { name: "app", version: "unknown", environment: "unknown" },
      session: { inactivityTimeoutMs: MIN_TIMEOUT_MS, backgroundTimeoutMs: MIN_TIMEOUT_MS, maxDurationMs: MAX_SESSION_DURATION_MS, sampleRate: 1 },
      selfDisableThreshold: 20,
      shutdownDeadlineMs: 2000,
      beforeSend: undefined,
      registerGlobal: false,
      debug: false,
    });
    for (const name of ["service.version", "session.inactivityTimeoutMs", "session.backgroundTimeoutMs", "session.maxDurationMs", "session.sampleRate", "diagnostics.selfDisableThreshold", "transport.shutdownDeadlineMs", "beforeSend"]) {
      expect(diagnostics.some((d) => d.includes(name)), name).toBe(true);
    }
    // Defaults when nothing is given; a rate below 0 clamps to 0; NaN is the default.
    const plain = normalizeOptions(base).config!;
    expect(plain.session).toEqual({ inactivityTimeoutMs: 30 * 60_000, backgroundTimeoutMs: 30_000, maxDurationMs: 4 * 3600_000, sampleRate: 1 });
    expect(normalizeOptions({ ...base, session: { sampleRate: -2 } }).config!.session.sampleRate).toBe(0);
    expect(normalizeOptions({ ...base, session: { sampleRate: NaN } }).config!.session.sampleRate).toBe(1);
  });

  it("init with a bad config returns a no-op, says why only when debug is on, and a later valid init works", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFetchStub();
    const stub = globalThis.fetch;
    const silent = initRUM({ ...base, endpoint: "" });
    expect(warn).not.toHaveBeenCalled();
    const loud = initRUM({ ...base, endpoint: "", debug: true });
    expect(warn.mock.calls.some((c) => /endpoint.*no-op/.test(String(c[1])))).toBe(true);
    for (const rum of [silent, loud]) {
      expect(rum.getSessionId()).toBeUndefined();
      expect(rum.session.id()).toBe("");
      expect(rum.withSpan("x", () => 3)).toBe(3);
      await expect(rum.flush()).resolves.toBeUndefined();
    }
    expect(globalThis.fetch).toBe(stub);
    expect(getRUM()).toBeUndefined();
    const real = initRUM(base);
    expect(getRUM()).toBe(real);
    expect(real.getSessionId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the project token, or any prefix of it, is in no diagnostic, URL or record", async () => {
    g.expo = { modules: { OuoReplay: nativeReplay } };
    const out: string[] = [];
    const collect = (...args: unknown[]): void => void out.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
    vi.spyOn(console, "log").mockImplementation(collect);
    vi.spyOn(console, "warn").mockImplementation(collect);
    const { rum, captured } = await start({ debug: true, replay: { enabled: true } });
    expect(nativeReplay.start).toHaveBeenCalled();
    rum.recordEvent("x");
    await fetch(`${BACKEND}/api`);
    await rum.flush();
    // Double init: a diagnostic, and only because debug is on.
    initRUM({ ...baseOptions(), debug: true });
    expect(out.some((l) => l.includes("init called twice"))).toBe(true);
    const everything = [...out, ...captured.requests.map((r) => r.url), JSON.stringify(captured.logs), JSON.stringify(captured.spans), JSON.stringify(captured.resource)].join("\n");
    expect(everything.length).toBeGreaterThan(500);
    expect(everything).not.toContain(TOKEN.slice(0, 5));
    // ERR-8: no record payloads in diagnostics either.
    rum.recordEvent("secret.event", { secret: "attribute-value-1234" });
    expect(out.join("\n")).not.toContain("attribute-value-1234");
    delete g.expo;
  });

  it("a second init without debug prints nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rum } = await start();
    expect(initRUM(baseOptions())).toBe(rum);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("public API per spec 3.1", () => {
  it("module-level functions forward to the instance; setUser, global attributes, recordEvent, recordException", async () => {
    const captured = installFetchStub();
    const rum = sdk.init(baseOptions()) as RUMInternal;
    await rum.ready;
    expect(sdk.getSessionId()).toBe(rum.session.id());

    sdk.setUser("u-1");
    expect(rum.session.userId()).toBe("u-1");
    rum.setUser({ id: "u-2" });
    expect(rum.session.userId()).toBe("u-2");
    sdk.setUser(null);
    expect(rum.session.userId()).not.toBe("u-2");
    sdk.setUser("u-3");

    sdk.setGlobalAttributes({ tenant: "acme", "ouo.reserved": "no", "session.id": "forged", "user.id": "forged" });
    sdk.recordEvent("cart.added", { "product.id": "p1", "ouo.mine": 1, "session.x": 2 }, "Added p1");
    sdk.recordEvent("ouo.forged");
    sdk.recordEvent("session.start");
    rum.addEvent("legacy.event", { a: 1 });
    sdk.recordException(new Error("handled one"), { "ouo.exception.fingerprint": "fp-1", area: "cart", "ouo.exception.kind": "forged" });
    sdk.recordException(new Error("unhandled by choice"), { "ouo.exception.handled": false });
    rum.captureError(new Error("alias"));
    sdk.trackNavigation("/Cart", { tab: "main", "ouo.navigation.kind": "forged" });
    rum.startSpan("app span", { attributes: { "ouo.x": 1, ok: true } }).end();
    await sdk.flush();

    const added = captured.byName("cart.added")[0]!;
    expect(added.body?.stringValue).toBe("Added p1");
    expect(attr(added.attributes, "product.id")).toBe("p1");
    expect(attr(added.attributes, "ouo.event.custom")).toBe(true);
    expect(attr(added.attributes, "ouo.mine")).toBeUndefined();
    expect(attr(added.attributes, "session.x")).toBeUndefined();
    // Global attributes on every later record; reserved keys rejected; the SDK's own win.
    expect(attr(added.attributes, "tenant")).toBe("acme");
    expect(attr(added.attributes, "ouo.reserved")).toBeUndefined();
    expect(attr(added.attributes, "session.id")).toBe(rum.session.id());
    expect(attr(added.attributes, "user.id")).toBe("u-3");
    const span = captured.spans.find((s) => s.name === "app span")!;
    expect(attr(span.attributes, "tenant")).toBe("acme");
    expect(attr(span.attributes, "ok")).toBe(true);
    expect(attr(span.attributes, "ouo.x")).toBeUndefined();
    expect(attr(span.attributes, "user.id")).toBe("u-3");
    // Reserved event names are dropped; addEvent goes through the same path.
    expect(captured.byName("ouo.forged")).toHaveLength(0);
    expect(captured.byName("session.start")).toHaveLength(1);
    expect(captured.byName("legacy.event")[0]!.body?.stringValue).toBe("legacy.event");

    const [first, second, alias] = captured.byName("exception");
    expect(attr(first!.attributes, "ouo.exception.source")).toBe("manual");
    expect(attr(first!.attributes, "ouo.exception.handled")).toBe(true);
    expect(attr(first!.attributes, "ouo.exception.kind")).toBe("captured");
    expect(attr(first!.attributes, "ouo.exception.fingerprint")).toBe("fp-1");
    expect(attr(first!.attributes, "area")).toBe("cart");
    expect(attr(second!.attributes, "ouo.exception.handled")).toBe(false);
    expect(attr(alias!.attributes, "ouo.exception.source")).toBe("manual");
    const nav = captured.byName("navigation")[0]!;
    expect(attr(nav.attributes, "tab")).toBe("main");
    expect(attr(nav.attributes, "ouo.navigation.kind")).toBe("screen");

    // Every rejected name was counted and reported (API-3, ERR-7).
    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await sdk.flush();
    expect(drops(captured).sort()).toEqual(["attribute/reserved_name=7", "log/reserved_name=2"]);
  });

  it("getTracerProvider / getLoggerProvider: host records get the session attributes (REL-5)", async () => {
    const { rum, captured } = await start();
    sdk.getTracerProvider().getTracer("host").startSpan("host span").end();
    sdk.getLoggerProvider().getLogger("host").emit({ body: "host log", attributes: { k: "v" } });
    await rum.flush();
    expect(attr(captured.spans.find((s) => s.name === "host span")!.attributes, "session.id")).toBe(rum.session.id());
    const log = captured.logs.find((l) => l.body?.stringValue === "host log")!;
    expect(attr(log.attributes, "session.id")).toBe(rum.session.id());
    expect(attr(log.attributes, "k")).toBe("v");
  });

  it("restartSession ends the session with reason manual and links the next one", async () => {
    const { rum, captured } = await start();
    const first = rum.session.id();
    sdk.restartSession();
    const second = rum.session.id();
    expect(second).not.toBe(first);
    expect(rum.session.previousId()).toBe(first);
    await rum.flush();
    const end = captured.byName("session.end")[0]!;
    expect(attr(end.attributes, "session.id")).toBe(first);
    expect(attr(end.attributes, "ouo.session.end_reason")).toBe("manual");
    expect(attr(captured.byName("session.start")[1]!.attributes, "session.previous_id")).toBe(first);
  });

  it("shutdown stops capture, removes every hook, ends the session, flushes, and init works again (LIF-4, LIF-5)", async () => {
    const errorSpy = (): void => undefined;
    console.error = errorSpy;
    const handlerBefore = g.ErrorUtils!.getGlobalHandler();
    const { rum, captured, storage } = await start();
    const stub = (globalThis.fetch as typeof fetch & { __original: typeof fetch }).__original;
    const first = rum.session.id();
    rum.recordEvent("last.event");
    const done = sdk.shutdown();
    // Synchronously: no instance, hooks gone, public functions are no-ops.
    expect(getRUM()).toBeUndefined();
    expect(globalThis.fetch).toBe(stub);
    expect(console.error).toBe(errorSpy);
    expect(g.ErrorUtils!.getGlobalHandler()).toBe(handlerBefore);
    rum.recordEvent("after.shutdown");
    expect(rum.getSessionId()).toBeUndefined();
    await done;
    expect(captured.byName("last.event")).toHaveLength(1);
    expect(captured.byName("after.shutdown")).toHaveLength(0);
    const end = captured.byName("session.end")[0]!;
    expect(attr(end.attributes, "session.id")).toBe(first);
    expect(attr(end.attributes, "ouo.session.end_reason")).toBe("shutdown");
    await expect(sdk.shutdown()).resolves.toBeUndefined();

    // A new start: a new session linked to the one that was shut down.
    const again = initRUM(baseOptions(storage)) as RUMInternal;
    await again.ready;
    expect(again.session.id()).not.toBe(first);
    expect(again.session.previousId()).toBe(first);
    again.recordEvent("second.life");
    await again.flush();
    expect(captured.byName("second.life")).toHaveLength(1);
    expect(captured.byName("session.end")).toHaveLength(1);
  });

  it("shutdown is bounded by transport.shutdownDeadlineMs when the collector hangs", async () => {
    globalThis.fetch = ((url: string) => (String(url).startsWith(ENDPOINT) ? new Promise(() => undefined) : Promise.resolve(new Response("[]")))) as unknown as typeof fetch;
    const rum = initRUM({ ...baseOptions(), transport: { shutdownDeadlineMs: 50 } }) as RUMInternal;
    rum.recordEvent("never.delivered");
    const t0 = Date.now();
    await rum.shutdown();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("replay.start / stop / capture / mask / unmask reach the native module when it has the method", async () => {
    const extra = { capture: vi.fn(), mask: vi.fn() };
    g.expo = { modules: { OuoReplay: { ...nativeReplay, ...extra } } };
    // A session recording into a buffer: the only kind `capture()` has something to send for.
    const { rum } = await start({ replay: { enabled: true, sampleRate: 0, onErrorSampleRate: 1 } });
    expect(rum.replay.isRecording()).toBe(true);
    sdk.replay.stop();
    expect(nativeReplay.stop).toHaveBeenCalledTimes(1);
    sdk.replay.start();
    expect(nativeReplay.start).toHaveBeenCalledTimes(2);
    sdk.replay.capture();
    sdk.replay.mask(42);
    expect(() => sdk.replay.unmask(42)).not.toThrow(); // not in this native module: a no-op
    expect(extra.capture.mock.calls).toEqual([["manual"]]);
    expect(extra.mask).toHaveBeenCalledWith(42);
    delete g.expo;
  });

  it("exports the spec version it implements (VER-2)", () => {
    expect(SPEC_VERSION).toBe("0.1.0-draft");
  });
});

describe("beforeSend (CFG-4, PRV-14)", () => {
  it("sees every log record and span before they are kept or sent; may change or drop them", async () => {
    const seen: string[] = [];
    const { rum, captured } = await start({
      beforeSend: (record) => {
        seen.push(`${record.type}:${record.name}`);
        if (record.name === "drop.me" || record.name === "drop span") return null;
        if (record.name === "drop.false") return false;
        if (record.name === "exception") {
          // PRV-14: the message and the stack pass through the hook.
          expect(record.attributes["exception.stacktrace"]).toContain("card 4111");
          return { ...record, body: "scrubbed", attributes: { ...record.attributes, "exception.message": "[scrubbed]", "exception.stacktrace": "[scrubbed]" } };
        }
        if (record.name === "mutate.me") {
          record.attributes["added"] = "in place";
          delete record.attributes["remove"];
          return undefined;
        }
        if (record.name === "rename span") return { ...record, name: "renamed span", attributes: { ...record.attributes, "http.url": "[redacted]" } };
        return record;
      },
    });
    rum.recordEvent("drop.me");
    rum.recordEvent("drop.false");
    rum.recordEvent("mutate.me", { remove: "x", keep: 1 });
    rum.recordException(new Error("card 4111 declined"));
    rum.startSpan("drop span").end();
    rum.startSpan("rename span").end();
    rum.log.info("a log line");
    const feedbackId = rum.feedback({ message: "what did I do?" });
    await rum.flush();

    expect(seen).toEqual(expect.arrayContaining(["log:session.start", "log:drop.me", "log:exception", "span:drop span", "log:log", "log:feedback"]));
    expect(captured.byName("drop.me")).toHaveLength(0);
    expect(captured.byName("drop.false")).toHaveLength(0);
    expect(captured.spans.map((s) => s.name).sort()).toEqual(["renamed span"]);
    expect(attr(captured.spans[0]!.attributes, "http.url")).toBe("[redacted]");
    const mutated = captured.byName("mutate.me")[0]!;
    expect(attr(mutated.attributes, "added")).toBe("in place");
    expect(attr(mutated.attributes, "remove")).toBeUndefined();
    expect(attr(mutated.attributes, "keep")).toBe(1);
    const err = captured.byName("exception")[0]!;
    expect(attr(err.attributes, "exception.message")).toBe("[scrubbed]");
    expect(err.body?.stringValue).toBe("scrubbed");
    expect(JSON.stringify(captured.logs)).not.toContain("4111");
    // Before persistence: a dropped record is not in the last-events buffer other records carry.
    expect(feedbackId).toBeDefined();
    const last = String(attr(captured.byName("feedback")[0]!.attributes, "ouo.last_events"));
    expect(last).toContain("mutate.me");
    expect(last).not.toContain("drop.me");

    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await rum.flush();
    expect(drops(captured).sort()).toEqual(["log/before_send=2", "span/before_send=1"]);
  });

  it("a hook that drops everything cannot hide the drop report, and the report does not feed itself", async () => {
    const seen: string[] = [];
    const { rum, captured } = await start({
      beforeSend: (record) => {
        seen.push(record.name);
        return null;
      },
    });
    rum.recordEvent("a");
    rum.recordEvent("b");
    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await rum.flush();
    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await rum.flush();
    // session.start, a, b were dropped: one report, never passed to the hook, and no report about the report.
    expect(drops(captured)).toEqual(["log/before_send=3"]);
    expect(seen).not.toContain(DROP_EVENT);
    expect(captured.logs).toHaveLength(1);
  });
});

describe("drop counting (ERR-7, ERR-9)", () => {
  it("DropCounter: totals by signal and reason, one report per interval, bounded", () => {
    vi.useFakeTimers();
    try {
      const counter = new DropCounter();
      const reports: string[][] = [];
      counter.onReport((list) => void reports.push(list.map((d) => `${d.signal}/${d.reason}=${d.count}`)));
      for (let i = 0; i < 1000; i++) counter.count("log", "sampling");
      counter.count("span", "queue_full", 3);
      counter.count("log", "sampling", 0);
      expect(reports).toEqual([]);
      vi.advanceTimersByTime(DROP_REPORT_INTERVAL_MS);
      expect(reports).toEqual([["log/sampling=1000", "span/queue_full=3"]]);
      vi.advanceTimersByTime(10 * DROP_REPORT_INTERVAL_MS);
      expect(reports).toHaveLength(1);
      counter.count("log", "rejected_status");
      counter.flush();
      expect(reports[1]).toEqual(["log/rejected_status=1"]);
      expect(counter.total("log", "sampling")).toBe(1000);
      counter.stop();
      counter.count("log", "rejected_status");
      vi.advanceTimersByTime(10 * DROP_REPORT_INTERVAL_MS);
      expect(reports).toHaveLength(2);
      expect(counter.total("log", "rejected_status")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-retryable answer drops the request and counts its records; the next request reports them", async () => {
    let reject = true;
    const bodies: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith(ENDPOINT)) return new Response("[]");
      if (reject) return new Response("{}", { status: 400 });
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const rum = initRUM(baseOptions()) as RUMInternal;
    await rum.ready;
    rum.recordEvent("lost.1");
    rum.recordEvent("lost.2");
    rum.startSpan("lost span").end();
    await rum.flush();
    reject = false;
    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await rum.flush();
    const sent = bodies.join("\n");
    // session.start + 2 events in one logs request, one span.
    expect(sent).toContain('"ouo.sdk.drop.reason"');
    expect(sent).toMatch(/"ouo\.sdk\.drop\.count","value":\{"intValue":3\}/);
    expect(sent).toMatch(/"ouo\.sdk\.drop\.count","value":\{"intValue":1\}/);
    expect(sent).not.toContain("lost.1");
  });

  it("an unsampled session counts its records as sampling drops and sends nothing", async () => {
    const { rum, captured } = await start({ session: { sampleRate: 0 } });
    rum.recordEvent("x");
    rum.startSpan("s").end();
    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await rum.flush();
    expect(captured.logs).toHaveLength(0);
    expect(captured.spans).toHaveLength(0);
  });
});

describe("no global registration unless asked (REL-4)", () => {
  it("by default nothing is registered, a host provider is untouched, and withSpan still parents requests", async () => {
    const hostProvider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(hostProvider);
    const hostTracer = trace.getTracer("host");
    const { rum, captured } = await start();
    expect(trace.getTracer("host")).toBe(hostTracer);
    expect(context.active()).toBe(context.active()); // noop manager: ROOT
    let inner: Promise<Response> | undefined;
    rum.withSpan("parent", () => {
      // The OpenTelemetry global context is not the SDK's: nothing is active there.
      expect(trace.getSpan(context.active())).toBeUndefined();
      inner = fetch(`${BACKEND}/api/x`);
      rum.log.info("inside");
    });
    await inner;
    await rum.flush();
    const parent = captured.spans.find((s) => s.name === "parent")!;
    const http = captured.spans.find((s) => s.name === "HTTP GET")!;
    expect(http.parentSpanId).toBe(parent.spanId);
    expect(captured.requests[0]!.headers["traceparent"]).toBe(`00-${parent.traceId}-${http.spanId}-01`);
    expect(captured.requests[0]!.headers["baggage"]).toBeUndefined();
    expect(captured.byName("log")[0]!.spanId).toBe(parent.spanId);
    await rum.shutdown();
    // The host's registration survived the SDK's whole life.
    expect(trace.getTracer("host")).toBe(hostTracer);
  });

  it("otel.registerGlobal registers the SDK's instances, removes them on shutdown, and never replaces the host's", async () => {
    const { rum, captured } = await start({ otel: { registerGlobal: true } });
    trace.getTracer("app").startSpan("via global").end();
    rum.withSpan("parent", () => expect(trace.getSpan(context.active())).toBeDefined());
    await rum.flush();
    expect(attr(captured.spans.find((s) => s.name === "via global")!.attributes, "session.id")).toBe(rum.session.id());
    await rum.shutdown();
    rum.withSpan("after", () => expect(trace.getSpan(context.active())).toBeUndefined());

    // A host that registered first keeps its provider.
    delete g.__ouoSessionProcessState;
    const hostProvider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(hostProvider);
    const hostTracer = trace.getTracer("host");
    const second = initRUM({ ...baseOptions(), otel: { registerGlobal: true } }) as RUMInternal;
    await second.ready;
    expect(trace.getTracer("host")).toBe(hostTracer);
    await second.shutdown();
    expect(trace.getTracer("host")).toBe(hostTracer);
  });
});

describe("truncation at source (REC-8)", () => {
  const bytes = (s: string): number => new TextEncoder().encode(s).length;

  it("cuts the stack to 25 KiB keeping the top frames and other strings to 4 KiB", () => {
    const stack = Array.from({ length: 2000 }, (_, i) => `    at frame${i} (app:///index.bundle:${i}:1)`).join("\n");
    const attrs: Record<string, unknown> = { "exception.stacktrace": stack, long: "é".repeat(5000), short: "ok", n: 5, "ouo.last_events": "[".padEnd(6000, "x") };
    expect(truncateAttributes(attrs)).toEqual([]);
    const cut = attrs["exception.stacktrace"] as string;
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_STACKTRACE_BYTES + 3);
    expect(cut.startsWith("    at frame0 ")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(bytes(attrs["long"] as string)).toBeLessThanOrEqual(MAX_STRING_BYTES + 3);
    expect(attrs["short"]).toBe("ok");
    expect(attrs["n"]).toBe(5);
    // JSON documents are not cut mid-way (they would not parse); only the record total bounds them.
    expect((attrs["ouo.last_events"] as string).length).toBe(6000);
    // Idempotent: a second pass changes nothing.
    const again = { ...attrs };
    truncateAttributes(again);
    expect(again).toEqual(attrs);
  });

  it("keeps a record's attributes under 64 KB by removing the largest", () => {
    const attrs: Record<string, unknown> = { "session.id": "s", "ouo.crash.images": "i".repeat(70_000), "ouo.crash.frames": "f".repeat(10_000) };
    for (let i = 0; i < 20; i++) attrs[`k${i}`] = "v".repeat(4000);
    const removed = truncateAttributes(attrs);
    expect(removed[0]).toBe("ouo.crash.images");
    const total = Object.entries(attrs).reduce((n, [k, v]) => n + k.length + (typeof v === "string" ? bytes(v) : 8), 0);
    expect(total).toBeLessThanOrEqual(MAX_RECORD_ATTRIBUTE_BYTES);
    expect(attrs["session.id"]).toBe("s");
  });

  it("applies to what is sent: a huge exception and a huge event", async () => {
    const { rum, captured } = await start();
    const err = new Error("m".repeat(10_000));
    err.stack = `Error: big\n${Array.from({ length: 3000 }, (_, i) => `    at f${i} (app:///a.js:${i}:1)`).join("\n")}`;
    rum.recordException(err);
    rum.recordEvent("big.event", { blob: "b".repeat(100_000) }, "B".repeat(50_000));
    await rum.flush();
    const e = captured.byName("exception")[0]!;
    expect(bytes(String(attr(e.attributes, "exception.stacktrace")))).toBeLessThanOrEqual(MAX_STACKTRACE_BYTES + 3);
    expect(bytes(String(attr(e.attributes, "exception.message")))).toBeLessThanOrEqual(MAX_STRING_BYTES + 3);
    const big = captured.byName("big.event")[0]!;
    expect(bytes(String(attr(big.attributes, "blob")))).toBeLessThanOrEqual(MAX_STRING_BYTES + 3);
    expect(bytes(big.body!.stringValue!)).toBeLessThanOrEqual(MAX_STRING_BYTES + 3);
  });

  it("appAttributes keeps finite primitives only and counts reserved keys", () => {
    const counter = new DropCounter();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(appAttributes({ a: 1, b: "x", c: true, d: null, e: undefined, f: NaN, g: cyclic, h: [1], "ouo.x": 1, "session.y": 2, "ouo.exception.fingerprint": "fp" }, counter)).toEqual({ a: 1, b: "x", c: true, "ouo.exception.fingerprint": "fp" });
    expect(counter.total("attribute", "reserved_name")).toBe(2);
    for (const junk of [undefined, null, 5, "s", [], cyclic]) expect(appAttributes(junk, counter)).toEqual({});
  });
});

describe("propagation (PRP-3, PRP-6)", () => {
  it("sessionBaggage sends only session.id, and only to the URLs that get traceparent", async () => {
    const { rum, captured } = await start({ propagation: { sessionBaggage: true }, user: { id: "u-1" } });
    await fetch(`${BACKEND}/api/a`);
    await fetch("http://elsewhere.test/b");
    expect(captured.requests[0]!.headers["baggage"]).toBe(`session.id=${rum.session.id()}`);
    expect(captured.requests[0]!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(captured.requests[1]!.headers["baggage"]).toBeUndefined();
    expect(captured.requests[1]!.headers["traceparent"]).toBeUndefined();
  });

  it("never overwrites a traceparent the app set (fetch)", async () => {
    const { rum, captured } = await start({ propagation: { sessionBaggage: true } });
    const mine = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const init = { headers: { TraceParent: mine, "x-app": "1" } };
    await fetch(`${BACKEND}/api/a`, init);
    await fetch(new Request(`${BACKEND}/api/b`, { headers: { traceparent: mine } }));
    await rum.flush();
    // The app's init object reached the original fetch untouched: nothing injected, baggage included.
    expect(captured.requests[0]!.headers).toBe(init.headers);
    expect(captured.requests[1]!.headers).toEqual({});
    // The requests are still recorded.
    expect(captured.spans.filter((s) => s.name === "HTTP GET")).toHaveLength(2);
  });
});
