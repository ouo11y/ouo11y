import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initRUM, type RUMInternal } from "../src/index";
import { CRASH_STORAGE_KEY } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import type { GlobalErrorHandler } from "../src/errors/install";
import { AppState } from "./mocks/react-native";
import { getRUM } from "../src/instance";

interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number };
}
interface OtlpLog {
  eventName?: string;
  body?: { stringValue?: string };
  traceId?: string;
  spanId?: string;
  severityNumber?: number;
  severityText?: string;
  timeUnixNano: string;
  attributes: OtlpAttr[];
}
interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  kind: number;
  attributes: OtlpAttr[];
}

const attr = (attrs: OtlpAttr[], key: string): unknown => {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.boolValue !== undefined) return v.boolValue;
  return v.doubleValue;
};

const ENDPOINT = "http://otel.test:4318";
const PROJECT_ID = "demo";
const TOKEN = "pt_test_token_0000000000000000";
const AUTHORIZATION = `Basic ${Buffer.from(`${PROJECT_ID}:${TOKEN}`).toString("base64")}`;
const BACKEND = "http://backend.test";

interface Captured {
  logs: OtlpLog[];
  spans: OtlpSpan[];
  resource: OtlpAttr[];
  requests: Array<{ url: string; headers: Record<string, string> }>;
  /** Every export request the SDK made to the collector: URL plus lower-cased headers. */
  exports: Array<{ url: string; headers: Record<string, string> }>;
}

function lowerHeaders(h: RequestInit["headers"] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

function installFetchStub(): Captured {
  const captured: Captured = { logs: [], spans: [], resource: [], requests: [], exports: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith(ENDPOINT)) {
      captured.exports.push({ url, headers: lowerHeaders(init?.headers) });
      const body = init?.body;
      const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)) as {
        resourceLogs?: Array<{ resource: { attributes: OtlpAttr[] }; scopeLogs: Array<{ logRecords: OtlpLog[] }> }>;
        resourceSpans?: Array<{ resource: { attributes: OtlpAttr[] }; scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
      };
      for (const rl of json.resourceLogs ?? []) {
        captured.resource = rl.resource.attributes;
        for (const sl of rl.scopeLogs) captured.logs.push(...sl.logRecords);
      }
      for (const rs of json.resourceSpans ?? []) {
        captured.resource = rs.resource.attributes;
        for (const ss of rs.scopeSpans) captured.spans.push(...ss.spans);
      }
      return new Response("{}", { status: 200 });
    }
    captured.requests.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url.includes("fail=500")) return new Response('{"error":"payment gateway unavailable"}', { status: 500 });
    if (url.includes("/missing")) return new Response("{}", { status: 404 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  return captured;
}

const g = globalThis as {
  ErrorUtils?: { getGlobalHandler: () => GlobalErrorHandler; setGlobalHandler: (h: GlobalErrorHandler) => void };
  HermesInternal?: unknown;
  __ouoSessionProcessState?: unknown;
};
let originalFetch: typeof fetch;
let defaultHandlerCalls: Array<[unknown, boolean | undefined]>;
let rejectionTracker: { onUnhandled: (id: number, e: unknown) => void } | undefined;

function makeOptions(storage: MemoryAsyncStorage, version = "2.3.0") {
  return {
    endpoint: ENDPOINT,
    projectId: PROJECT_ID,
    projectToken: TOKEN,
    service: { name: "mobile-store", version, environment: "test" },
    tracing: { propagateTo: [BACKEND] },
    storage,
    device: { modelIdentifier: "iPhone15,2", manufacturer: "Apple" },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  originalFetch = globalThis.fetch;
  defaultHandlerCalls = [];
  let handler: GlobalErrorHandler = (e, f) => {
    defaultHandlerCalls.push([e, f]);
  };
  g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h) => (handler = h) };
  g.HermesInternal = {
    hasPromise: () => true,
    enablePromiseRejectionTracker: (o: { onUnhandled: (id: number, e: unknown) => void }) => (rejectionTracker = o),
  };
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  globalThis.fetch = originalFetch;
  delete g.ErrorUtils;
  delete g.HermesInternal;
  delete g.__ouoSessionProcessState;
});

describe("initRUM end to end against a stubbed OTLP endpoint", () => {
  it("case 7 + case 6: every signal carries session.id; a fatal error writes the marker and the relaunch ends the session as crash", async () => {
    const captured = installFetchStub();
    const storage = new MemoryAsyncStorage();
    const rum = initRUM(makeOptions(storage)) as RUMInternal;
    const sessionId = rum.session.id();
    await rum.ready;

    await fetch(`${BACKEND}/api/products`);
    await expect(fetch(`${BACKEND}/api/checkout?fail=500`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).resolves.toHaveProperty("status", 500);
    await fetch(`${BACKEND}/api/products/missing`);
    await fetch("http://third-party.test/ping");
    rum.trackNavigation("/Cart");
    rum.addEvent("cart.added", { "product.id": "p-1001" });
    rum.captureError(new Error("handled"), { screen: "Cart" });
    rejectionTracker!.onUnhandled(1, new Error("rejected"));
    rum.setUser({ id: "user-7" });
    console.error("console says no");

    // Fatal error through the global handler.
    const t0 = Date.now();
    g.ErrorUtils!.getGlobalHandler()(new TypeError("fatal boom"), true);
    while (defaultHandlerCalls.length === 0 && Date.now() - t0 < 3000) await sleep(10);
    const fatalWait = Date.now() - t0;
    expect(defaultHandlerCalls).toHaveLength(1);
    // The previous handler must run promptly (marker + flush), not after the 2 s timeout.
    expect(fatalWait).toBeLessThan(1000);
    expect(JSON.parse(storage.peek(CRASH_STORAGE_KEY)!)).toMatchObject({ sessionId, type: "TypeError", message: "fatal boom" });

    await rum.flush();

    // ---- OTLP routes and the Basic credential (ADR-0007) ----
    const exportUrls = new Set(captured.exports.map((e) => e.url));
    expect(exportUrls).toEqual(new Set([`${ENDPOINT}/v1/traces`, `${ENDPOINT}/v1/logs`]));
    for (const e of captured.exports) {
      expect(e.headers["authorization"]).toBe(AUTHORIZATION);
      expect(e.headers["x-ouo-project-token"]).toBeUndefined();
      expect(e.headers["content-type"]).toBe("application/json");
    }

    // ---- traces ----
    // Exports to the collector are never traced: only the four app requests have spans.
    const spans = captured.spans;
    expect(spans.map((s) => s.name)).toEqual(["HTTP GET", "HTTP POST", "HTTP GET", "HTTP GET"]);
    for (const s of spans) {
      expect(attr(s.attributes, "session.id")).toBe(sessionId);
      expect(attr(s.attributes, "ouo.platform")).toBe("mobile");
      expect(attr(s.attributes, "service.version")).toBe("2.3.0");
      // Spec PRV-13: no user id before setUser.
      expect(attr(s.attributes, "user.id")).toBeUndefined();
    }
    expect(attr(spans[1]!.attributes, "http.response.status_code")).toBe(500);
    expect(attr(spans[2]!.attributes, "http.response.status_code")).toBe(404);
    expect(attr(spans[0]!.attributes, "server.address")).toBe("backend.test");

    // ---- propagation ----
    expect(captured.requests[0]!.headers["traceparent"]).toBe(`00-${spans[0]!.traceId}-${spans[0]!.spanId}-01`);
    // No baggage unless `propagation.sessionBaggage` is set (spec PRP-6; test/step-a.test.ts covers it).
    expect(captured.requests[0]!.headers["baggage"]).toBeUndefined();
    expect(captured.requests[1]!.headers["content-type"]).toBe("application/json");
    expect(captured.requests[3]!.headers["traceparent"]).toBeUndefined();

    // ---- resource ----
    expect(attr(captured.resource, "service.name")).toBe("mobile-store");
    expect(attr(captured.resource, "service.version")).toBe("2.3.0");
    expect(attr(captured.resource, "deployment.environment.name")).toBe("test");
    expect(attr(captured.resource, "ouo.platform")).toBe("mobile");
    expect(attr(captured.resource, "os.name")).toBe("iOS");
    expect(attr(captured.resource, "os.version")).toBe("17.5");
    expect(attr(captured.resource, "device.model.identifier")).toBe("iPhone15,2");
    expect(attr(captured.resource, "device.manufacturer")).toBe("Apple");
    expect(attr(captured.resource, "ouo.sdk.name")).toBe("@ouo11y/react-native");

    // ---- logs ----
    const logs = captured.logs;
    const byName = (name: string) => logs.filter((l) => attr(l.attributes, "event.name") === name);
    for (const l of logs) {
      expect(attr(l.attributes, "session.id")).toBe(sessionId);
      expect(attr(l.attributes, "ouo.platform")).toBe("mobile");
      expect(attr(l.attributes, "service.version")).toBe("2.3.0");
      expect(l.eventName).toBe(attr(l.attributes, "event.name"));
    }
    expect(byName("session.start")).toHaveLength(1);
    expect(attr(byName("session.start")[0]!.attributes, "ouo.session.started_at")).toBeTypeOf("number");
    expect(byName("session.end")).toHaveLength(0);
    expect(byName("http.request.failed")).toHaveLength(1);
    expect(attr(byName("http.request.failed")[0]!.attributes, "http.response.status_code")).toBe(500);
    expect(attr(byName("http.request.failed")[0]!.attributes, "url.full")).toBe(`${BACKEND}/api/checkout?fail=REDACTED`); // query values are redacted (spec PRV-10)
    expect(attr(byName("navigation")[0]!.attributes, "url.path")).toBe("/Cart");
    expect(attr(byName("cart.added")[0]!.attributes, "ouo.event.custom")).toBe(true);
    const exceptions = byName("exception").map((l) => ({
      kind: attr(l.attributes, "ouo.exception.kind"),
      fatal: attr(l.attributes, "ouo.exception.fatal"),
      handled: attr(l.attributes, "ouo.exception.handled"),
      message: attr(l.attributes, "exception.message"),
    }));
    expect(exceptions).toEqual([
      { kind: "captured", fatal: false, handled: true, message: "handled" },
      { kind: "unhandledrejection", fatal: false, handled: false, message: "rejected" },
      { kind: "console", fatal: false, handled: true, message: "console says no" },
      { kind: "uncaught", fatal: true, handled: false, message: "fatal boom" },
    ]);
    expect(attr(byName("exception")[0]!.attributes, "screen")).toBe("Cart");
    // user.id switches after setUser
    expect(attr(byName("exception")[0]!.attributes, "user.id")).toBeUndefined();
    expect(attr(byName("exception")[0]!.attributes, "ouo.user.anonymous")).toBeUndefined();
    expect(attr(byName("exception")[3]!.attributes, "user.id")).toBe("user-7");
    expect(attr(byName("exception")[3]!.attributes, "ouo.user.anonymous")).toBe(false);

    await rum._uninstall();
    expect(globalThis.fetch).not.toHaveProperty("__ouo");

    // ---- relaunch: new process memory, same storage ----
    delete g.__ouoSessionProcessState;
    const captured2 = installFetchStub();
    const rum2 = initRUM(makeOptions(storage)) as RUMInternal;
    await rum2.ready;
    expect(rum2.session.id()).not.toBe(sessionId);
    expect(rum2.session.previousId()).toBe(sessionId);
    expect(rum2.session.userId()).toBe("user-7");
    await rum2.flush();
    const names = captured2.logs.map((l) => attr(l.attributes, "event.name"));
    expect(names).toEqual(["session.end", "session.start"]);
    const end = captured2.logs[0]!;
    expect(attr(end.attributes, "session.id")).toBe(sessionId);
    expect(attr(end.attributes, "ouo.session.end_reason")).toBe("crash");
    expect(attr(end.attributes, "user.id")).toBe("user-7");
    expect(attr(end.attributes, "session.previous_id")).toBeUndefined();
    const start = captured2.logs[1]!;
    expect(attr(start.attributes, "session.id")).toBe(rum2.session.id());
    expect(attr(start.attributes, "session.previous_id")).toBe(sessionId);
    expect(storage.peek(CRASH_STORAGE_KEY)).toBeNull();
    await rum2._uninstall();
  });

  it("case 5 through AppState: a long background stay rotates the session and flushes", async () => {
    const captured = installFetchStub();
    const storage = new MemoryAsyncStorage();
    // The shortest background timeout the SDK accepts is a minute (spec CFG-2): the clock is moved past it.
    const rum = initRUM({ ...makeOptions(storage, "2.4.0"), session: { backgroundTimeoutMs: 60_000 } }) as RUMInternal;
    await rum.ready;
    const first = rum.session.id();
    AppState.__emit("inactive");
    AppState.__emit("background");
    const backgroundedAt = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => backgroundedAt + 61_000);
    AppState.__emit("active");
    expect(rum.session.id()).not.toBe(first);
    expect(rum.session.previousId()).toBe(first);
    await rum.flush();
    const names = captured.logs.map((l) => [
      attr(l.attributes, "event.name"),
      attr(l.attributes, "session.id"),
      attr(l.attributes, "ouo.session.end_reason") ?? attr(l.attributes, "ouo.app.state"),
    ]);
    // app.lifecycle (G4): inactive and background in the old session, foreground in the new one.
    expect(names).toEqual([
      ["session.start", first, undefined],
      ["app.lifecycle", first, "inactive"],
      ["app.lifecycle", first, "background"],
      ["session.end", first, "background"],
      ["session.start", rum.session.id(), undefined],
      ["app.lifecycle", rum.session.id(), "foreground"],
    ]);
    expect(captured.logs[2]!.body).toEqual({ stringValue: "app background" });
    expect(attr(captured.logs[4]!.attributes, "session.previous_id")).toBe(first);
    expect(attr(captured.resource, "service.version")).toBe("2.4.0");
    await rum._uninstall();
  });
});

describe("session sampling (8b)", () => {
  it("sampleRate 0 exports nothing; 1 exports the session's signals", async () => {
    const captured = installFetchStub();
    const off = initRUM({ ...makeOptions(new MemoryAsyncStorage()), session: { sampleRate: 0 } }) as RUMInternal;
    await off.ready;
    await fetch(`${BACKEND}/api/products`);
    off.addEvent("cart.added");
    off.captureError(new Error("not exported"));
    await off.flush();
    expect(captured.logs).toHaveLength(0);
    expect(captured.spans).toHaveLength(0);
    expect(captured.exports).toHaveLength(0);
    // The app's own request still went through.
    expect(captured.requests.some((r) => r.url === `${BACKEND}/api/products`)).toBe(true);
    await off._uninstall();

    // A new process: within one, a re-init resumes the session, and its sampling decision with it (spec SMP-1).
    delete g.__ouoSessionProcessState;
    const on = initRUM({ ...makeOptions(new MemoryAsyncStorage()), session: { sampleRate: 1 } }) as RUMInternal;
    await on.ready;
    on.addEvent("cart.added");
    await on.flush();
    expect(captured.logs.length).toBeGreaterThan(0);
    expect(captured.logs.every((l) => attr(l.attributes, "session.id") === on.session.id())).toBe(true);
  });
});
