/**
 * Bridge parity (checklist section 3): G3 span and log API, G4 timeline, G5 error context, G6
 * Sentry forwarding, Q1 de-duplication. End to end through `initRUM` against a stubbed collector.
 */
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initRUM, RUMProvider, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";
import type { SentryClientLike, SentryEventLike, SentryHintLike } from "../src/types";
import { attr, BACKEND, baseOptions, g, installErrorUtils, installFetchStub, waitFor, type Captured } from "./support/otlp";

let originalFetch: typeof fetch;
let defaultHandlerCalls: Array<[unknown, boolean | undefined]>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  defaultHandlerCalls = installErrorUtils();
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  globalThis.fetch = originalFetch;
  delete g.ErrorUtils;
  delete g.__ouoSessionProcessState;
  delete g.expo;
});

async function start(extra: Record<string, unknown> = {}): Promise<{ rum: RUMInternal; captured: Captured; storage: MemoryAsyncStorage }> {
  const captured = installFetchStub();
  const storage = new MemoryAsyncStorage();
  const rum = initRUM({ ...baseOptions(storage), ...extra }) as RUMInternal;
  await rum.ready;
  return { rum, captured, storage };
}

const exceptions = (c: Captured) =>
  c.byName("exception").map((l) => ({
    kind: attr(l.attributes, "ouo.exception.kind"),
    fatal: attr(l.attributes, "ouo.exception.fatal"),
    message: attr(l.attributes, "exception.message"),
  }));

describe("G4 timeline parity with the Sentry bridge", () => {
  type Handlers = { onTouchStart: (e: object) => void; onTouchEnd: (e: object) => void; onTouchCancel: (e: object) => void };
  // <Pressable testID="add-to-cart" role="button"><Text>Add</Text></Pressable> on ProductScreen.
  const screen = { elementType: { displayName: "ProductScreen" }, memoizedProps: {}, return: null };
  const pressable = { elementType: { displayName: "Pressable" }, memoizedProps: { testID: "add-to-cart", role: "button" }, return: screen };
  const text = { elementType: "RCTText", memoizedProps: { children: "Add" }, return: { elementType: { displayName: "View" }, memoizedProps: { testID: "add-to-cart", role: "button" }, return: pressable } };

  /** A touch from start to end: held `ms`, moved `dx`, `dy` points. Returns the start time. */
  function touch(el: ReactElement<Handlers>, fiber: object | undefined, ms = 60, dx = 0, dy = 0, end: keyof Handlers = "onTouchEnd"): number {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    el.props.onTouchStart({ _targetInst: fiber, nativeEvent: { pageX: 100, pageY: 200 } });
    now.mockReturnValue(t0 + ms);
    el.props[end]({ nativeEvent: { pageX: 100 + dx, pageY: 200 + dy } });
    now.mockRestore();
    return t0;
  }

  it("ui.tap from RUMProvider touches: target, path, view type, gesture and screen, stamped at the touch start", async () => {
    const { rum, captured } = await start();
    const el = RUMProvider({ rum }) as ReactElement<Handlers>;
    rum.trackNavigation("/Products/Product");
    const t0 = touch(el, text);
    touch(el, text, 800);
    touch(el, text, 300, 0, -120, "onTouchCancel"); // a scroll view took the touch over
    touch(el, undefined); // no fiber: activity only
    await rum.flush();
    const taps = captured.byName("ui.tap");
    expect(taps.map((l) => attr(l.attributes, "ouo.ui.gesture"))).toEqual(["tap", "long_press", "swipe"]);
    const a = taps[0]!.attributes;
    expect([attr(a, "ouo.ui.target"), attr(a, "ouo.ui.path"), attr(a, "ouo.ui.view_type"), attr(a, "app.screen.name")]).toEqual([
      "add-to-cart",
      "add-to-cart > ProductScreen",
      "button",
      "Product",
    ]);
    expect(taps.map((l) => l.body?.stringValue)).toEqual(["Tap add-to-cart (button) on Product", "Long press add-to-cart (button) on Product", "Swipe add-to-cart (button) on Product"]);
    expect(BigInt(taps[0]!.timeUnixNano) / 1_000_000n).toBe(BigInt(t0));
  });

  it("one record per touch: a nested provider (same event bubbling) and a second finger add none", async () => {
    const { rum, captured } = await start();
    const outer = RUMProvider({ rum }) as ReactElement<Handlers>;
    const inner = RUMProvider({ rum }) as ReactElement<Handlers>;
    const down = { _targetInst: text, nativeEvent: { touches: [1] } };
    inner.props.onTouchStart(down);
    outer.props.onTouchStart(down); // the same touch bubbling on
    const second = { _targetInst: text, nativeEvent: { touches: [1, 2] } };
    inner.props.onTouchStart(second);
    outer.props.onTouchStart(second);
    const up = { nativeEvent: { touches: [] } };
    inner.props.onTouchEnd(up);
    outer.props.onTouchEnd(up);
    await rum.flush();
    expect(captured.byName("ui.tap")).toHaveLength(1);
  });

  it("the screen is the one the touch started on, even when the press navigates before the finger lifts", async () => {
    const { rum, captured } = await start();
    const el = RUMProvider({ rum }) as ReactElement<Handlers>;
    rum.trackNavigation("/Product");
    el.props.onTouchStart({ _targetInst: text });
    rum.trackNavigation("/Cart"); // onLongPress or onPressIn navigated
    el.props.onTouchEnd({});
    await rum.flush();
    const [tap] = captured.byName("ui.tap");
    expect(attr(tap!.attributes, "app.screen.name")).toBe("Product");
    expect(tap!.body?.stringValue).toMatch(/ on Product$/);
  });

  it("a touch whose end never came does not block or replace the next ones", async () => {
    const { rum, captured } = await start();
    const el = RUMProvider({ rum }) as ReactElement<Handlers>;
    const lost = { elementType: { displayName: "Pressable" }, memoizedProps: { testID: "unmounted" }, return: screen };
    el.props.onTouchStart({ _targetInst: lost, nativeEvent: { touches: [1] } }); // its view unmounted: no end
    for (let i = 0; i < 3; i++) touch(el, text);
    await rum.flush();
    const taps = captured.byName("ui.tap");
    expect(taps.map((l) => `${attr(l.attributes, "ouo.ui.target")} ${attr(l.attributes, "ouo.ui.gesture")}`)).toEqual(Array(3).fill("add-to-cart tap"));
  });

  it("timeline.tapLabels false: no label leaves the device, the step keeps gesture, view type and screen", async () => {
    const { rum, captured } = await start({ timeline: { tapLabels: false } });
    const el = RUMProvider({ rum }) as ReactElement<Handlers>;
    rum.trackNavigation("/Cart");
    touch(el, text, 900);
    await rum.flush();
    const [tap] = captured.byName("ui.tap");
    expect(Object.fromEntries(tap!.attributes.filter((x) => x.key.startsWith("ouo.ui.") || x.key === "app.screen.name").map((x) => [x.key, attr(tap!.attributes, x.key)]))).toEqual({
      "ouo.ui.target": "button",
      "ouo.ui.view_type": "button",
      "ouo.ui.gesture": "long_press",
      "app.screen.name": "Cart",
    });
    expect(tap!.body?.stringValue).toBe("Long press button on Cart");
    expect(JSON.stringify(captured)).not.toContain("add-to-cart");
  });

  it("navigation: one record per screen change, ouo.navigation.kind = screen like the bridge", async () => {
    const { rum, captured } = await start();
    rum.trackNavigation("/Home");
    rum.trackNavigation("/Home");
    rum.trackNavigation("/Products");
    await rum.flush();
    const nav = captured.byName("navigation");
    expect(nav.map((l) => [attr(l.attributes, "url.path"), attr(l.attributes, "ouo.navigation.from"), attr(l.attributes, "ouo.navigation.kind")])).toEqual([
      ["/Home", "", "screen"],
      ["/Products", "/Home", "screen"],
    ]);
  });

  it("http.request for answered requests below 500, with the request span's trace id and span id", async () => {
    const { rum, captured } = await start();
    await fetch(`${BACKEND}/api/products`);
    await fetch(`${BACKEND}/api/products/missing`);
    await fetch(`${BACKEND}/api/checkout?fail=500`, { method: "POST" });
    await rum.flush();
    const requests = captured.byName("http.request");
    expect(requests.map((l) => attr(l.attributes, "http.response.status_code"))).toEqual([200, 404]);
    expect(requests[0]!.body?.stringValue).toBe(`GET ${BACKEND}/api/products`);
    expect(attr(requests[0]!.attributes, "http.request.method")).toBe("GET");
    expect(attr(requests[0]!.attributes, "url.full")).toBe(`${BACKEND}/api/products`);
    const [s0, s1, s2] = captured.spans;
    expect(requests[0]!.traceId).toBe(s0!.traceId);
    expect(requests[0]!.spanId).toBe(s0!.spanId);
    expect(requests[1]!.spanId).toBe(s1!.spanId);
    // The failure stays http.request.failed, now with its span too.
    const failed = captured.byName("http.request.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.spanId).toBe(s2!.spanId);
  });

  it("each timeline kind can be switched off", async () => {
    const { rum, captured } = await start({ timeline: { taps: false, requests: false, appLifecycle: false } });
    rum.trackTap("buy");
    await fetch(`${BACKEND}/api/products`);
    await rum.flush();
    expect(captured.byName("ui.tap")).toHaveLength(0);
    expect(captured.byName("http.request")).toHaveLength(0);
    expect(captured.spans).toHaveLength(1);
  });
});

describe("G3 span and log API", () => {
  it("withSpan: requests, logs and errors inside join its trace; the span ends", async () => {
    const { rum, captured } = await start();
    let inner: Promise<Response> | undefined;
    const value = rum.withSpan("checkout", (span) => {
      span.setAttribute("cart.items", 3);
      inner = fetch(`${BACKEND}/api/checkout`, { method: "POST" });
      rum.log.info("checkout started", { "cart.items": 3 });
      rum.captureError(new Error("coupon invalid"));
      return 42;
    }, { attributes: { "app.flow": "checkout" } });
    expect(value).toBe(42);
    await inner;
    await rum.flush();
    const root = captured.spans.find((s) => s.name === "checkout")!;
    const http = captured.spans.find((s) => s.name === "HTTP POST")!;
    expect(attr(root.attributes, "cart.items")).toBe(3);
    expect(attr(root.attributes, "app.flow")).toBe("checkout");
    expect(attr(root.attributes, "session.id")).toBe(rum.session.id());
    expect(http.traceId).toBe(root.traceId);
    expect(http.parentSpanId).toBe(root.spanId);
    // The backend gets the same trace.
    expect(captured.requests[0]!.headers["traceparent"]).toBe(`00-${root.traceId}-${http.spanId}-01`);
    const log = captured.byName("log")[0]!;
    expect(log.body?.stringValue).toBe("checkout started");
    expect(log.severityText).toBe("INFO");
    expect(log.severityNumber).toBe(9);
    expect(attr(log.attributes, "message")).toBe("checkout started");
    expect(attr(log.attributes, "cart.items")).toBe(3);
    expect(attr(log.attributes, "session.id")).toBe(rum.session.id());
    expect(log.traceId).toBe(root.traceId);
    expect(log.spanId).toBe(root.spanId);
    const err = captured.byName("exception")[0]!;
    expect(err.traceId).toBe(root.traceId);
    expect(attr(err.attributes, "ouo.exception.trace_link")).toBe("active_span");
  });

  it("withSpan: a rejection marks the span, reports the exception as a log record and rethrows; the unhandled error joins that span", async () => {
    const { rum, captured } = await start();
    const boom = new Error("payment declined");
    await expect(
      rum.withSpan("pay", async () => {
        await Promise.resolve();
        throw boom;
      }),
    ).rejects.toBe(boom);
    rum.captureError(boom); // e.g. the app's catch, outside the span
    await rum.flush();
    const pay = captured.spans.find((s) => s.name === "pay")!;
    expect(pay.status?.code).toBe(SpanStatusCode.ERROR);
    // No span event (spec REL-7): the error is an `exception` log record with the span's ids (SIG-33).
    expect(pay.events ?? []).toEqual([]);
    const errors = captured.byName("exception");
    // One from the span (the error escaped it), one from the app's captureError.
    expect(errors).toHaveLength(2);
    for (const err of errors) {
      expect(err.traceId).toBe(pay.traceId);
      expect(err.spanId).toBe(pay.spanId);
      expect(attr(err.attributes, "ouo.exception.trace_link")).toBe("span");
    }
    expect(attr(errors[0]!.attributes, "ouo.exception.source")).toBeUndefined();
    expect(attr(errors[1]!.attributes, "ouo.exception.source")).toBe("manual");
  });

  it("startSpan: explicit parent across an await, null for a new trace; log levels", async () => {
    const { rum, captured } = await start();
    const parent = rum.startSpan("load");
    await Promise.resolve();
    const child = rum.startSpan("parse", { parent });
    const other = rum.startSpan("unrelated", { parent: null });
    rum.log.warn("slow parse", undefined, { span: child });
    rum.log("fatal", "out of memory");
    child.end();
    other.end();
    parent.end();
    await rum.flush();
    const by = (n: string) => captured.spans.find((s) => s.name === n)!;
    expect(by("parse").parentSpanId).toBe(by("load").spanId);
    expect(by("unrelated").traceId).not.toBe(by("load").traceId);
    const [warn, fatal] = captured.byName("log");
    expect(warn!.severityText).toBe("WARN");
    expect(warn!.spanId).toBe(by("parse").spanId);
    expect(fatal!.severityText).toBe("FATAL");
    expect(fatal!.traceId ?? "").toBe("");
  });
});

describe("G5 error context", () => {
  it("an error right after a failed request carries that request's trace; a rejected fetch error carries its own span", async () => {
    const { rum, captured } = await start();
    await fetch(`${BACKEND}/api/checkout?fail=500`, { method: "POST" });
    rum.captureError(new Error("checkout failed: 500"));
    const down = await fetch(`${BACKEND}/network-down`).catch((e: unknown) => e);
    rum.captureError(down);
    await rum.flush();
    const [first, second] = captured.byName("exception");
    const [s500, sDown] = captured.spans;
    expect(first!.spanId).toBe(s500!.spanId);
    expect(attr(first!.attributes, "ouo.exception.trace_link")).toBe("failed_request");
    expect(second!.spanId).toBe(sDown!.spanId);
    expect(attr(second!.attributes, "ouo.exception.trace_link")).toBe("span");
  });

  it("no span and no recent failure: no trace link", async () => {
    const { rum, captured } = await start();
    rum.captureError(new Error("plain"));
    await rum.flush();
    const e = captured.byName("exception")[0]!;
    expect(e.traceId ?? "").toBe("");
    expect(attr(e.attributes, "ouo.exception.trace_link")).toBeUndefined();
  });

  it("device model from expo-device without app code", async () => {
    g.expo = { modules: { ExpoDevice: { modelId: "iPhone17,2", modelName: "iPhone 16 Pro Max", isDevice: true } } };
    const { rum, captured } = await start();
    rum.addEvent("x");
    await rum.flush();
    expect(attr(captured.resource, "device.model.identifier")).toBe("iPhone17,2");
    expect(attr(captured.resource, "device.model.name")).toBe("iPhone 16 Pro Max");
  });
});

/** Minimal Sentry client: `captureException` runs the `beforeSendEvent` hooks like @sentry/core's sendEvent. */
function fakeSentry() {
  const hooks = new Set<(e: SentryEventLike, h?: SentryHintLike) => void>();
  const client: SentryClientLike = {
    on(_hook, cb) {
      hooks.add(cb);
      return () => hooks.delete(cb);
    },
  };
  const send = (event: SentryEventLike, hint?: SentryHintLike) => hooks.forEach((h) => h(event, hint));
  const captureException = (error: Error, mechanism = { type: "generic", handled: true }, level = "error") =>
    send({ event_id: "e1", level, exception: { values: [{ type: error.name, value: error.message, mechanism }] } }, { originalException: error });
  return { client, send, captureException, hooks };
}

describe("G6 Sentry.captureException reaches ouo (opt-in)", () => {
  it("forwards errors only Sentry saw, once; skips ouo's own captures, messages and transactions", async () => {
    const sentry = fakeSentry();
    const { rum, captured } = await start({ errors: { forwardSentryErrors: sentry.client } });
    sentry.captureException(new Error("from captureException"));
    // Error boundary: React logs the error, Sentry.ErrorBoundary captures the same object.
    const boundary = new Error("render failed");
    console.error(boundary);
    sentry.captureException(boundary, { type: "auto.function.react.error_boundary", handled: true });
    // ouo's global handler chains to Sentry's, which captures it again: one record.
    const uncaught = new Error("uncaught non-fatal");
    g.ErrorUtils!.getGlobalHandler()(uncaught, false);
    sentry.captureException(uncaught, { type: "generic", handled: true });
    // captureMessage, transactions and rejections ouo forwarded itself are not errors to forward.
    sentry.send({ level: "info", exception: { values: [{ type: "Error", value: "hello", mechanism: { type: "generic", synthetic: true } }] } });
    sentry.send({ type: "transaction" });
    sentry.captureException(new Error("rejected"), { type: "onunhandledrejection", handled: false });
    // A plain object payload (captureException of a string) still becomes an exception.
    sentry.send({ event_id: "e9", level: "error", exception: { values: [{ type: "Error", value: "just a string", mechanism: { type: "generic", handled: true }, stacktrace: { frames: [{ function: "f", filename: "app:///main.jsbundle", lineno: 1, colno: 2 }] } }] } }, { originalException: "just a string" });
    await rum.flush();
    expect(exceptions(captured)).toEqual([
      { kind: "sentry", fatal: false, message: "from captureException" },
      { kind: "console", fatal: false, message: "Error: render failed" },
      { kind: "uncaught", fatal: false, message: "uncaught non-fatal" },
      { kind: "sentry", fatal: false, message: "just a string" },
    ]);
    const fwd = captured.byName("exception")[0]!;
    expect(attr(fwd.attributes, "ouo.sentry.event_id")).toBe("e1");
    expect(attr(fwd.attributes, "ouo.sentry.mechanism")).toBe("generic");
    expect(attr(fwd.attributes, "ouo.exception.handled")).toBe(true);
    expect(attr(captured.byName("exception")[3]!.attributes, "exception.stacktrace")).toContain("at f (app:///main.jsbundle:1:2) [in app]");
    await rum._uninstall();
    expect(sentry.hooks.size).toBe(0);
  });

  it("off by default: Sentry's events are not read", async () => {
    const sentry = fakeSentry();
    const { rum, captured } = await start();
    sentry.captureException(new Error("only Sentry"));
    await rum.flush();
    expect(sentry.hooks.size).toBe(0);
    expect(captured.byName("exception")).toHaveLength(0);
  });

  it("warns on something that is not a Sentry client", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start({ debug: true, errors: { forwardSentryErrors: {} } });
    expect(warn.mock.calls.some((c) => c.some((a) => /forwardSentryErrors/.test(String(a))))).toBe(true);
  });
});

describe("Q1 one fatal is one exception", () => {
  it("the dev handler's console.error echo and a React dev re-throw are not reported again", async () => {
    const { rum, captured, storage } = await start();
    const sessionId = rum.session.id();
    // The previous handler (React Native's dev handler) prints the fatal through console.error.
    const handler = g.ErrorUtils!.getGlobalHandler();
    const fatal = new Error("Fatal error from the Chaos screen");
    handler(fatal, true);
    await waitFor(() => defaultHandlerCalls.length === 1);
    console.error(`Error: ${fatal.message}`, "\n    in ChaosScreen");
    console.error(fatal);
    const rethrown = new Error(fatal.message); // React dev replays the render: a new object
    handler(rethrown, true);
    // A different error later is still reported.
    console.error("unrelated warning");
    await rum.flush();
    expect(exceptions(captured)).toEqual([
      { kind: "uncaught", fatal: true, message: "Fatal error from the Chaos screen" },
      { kind: "console", fatal: false, message: "unrelated warning" },
    ]);
    await rum._uninstall();

    // Relaunch: the crashed session ends once, and nothing of it follows its session.end.
    delete g.__ouoSessionProcessState;
    const captured2 = installFetchStub();
    const rum2 = initRUM(baseOptions(storage)) as RUMInternal;
    await rum2.ready;
    await rum2.flush();
    const ends = captured2.byName("session.end");
    expect(ends).toHaveLength(1);
    expect(attr(ends[0]!.attributes, "session.id")).toBe(sessionId);
    expect(attr(ends[0]!.attributes, "ouo.session.end_reason")).toBe("crash");
  });
});

describe("Q1 dev symbolication", () => {
  it("Metro's /symbolicate and /__sentry/ calls are not traced in dev", async () => {
    const dev = globalThis as { __DEV__?: boolean };
    dev.__DEV__ = true;
    try {
      const { rum, captured } = await start();
      await fetch("http://localhost:8081/symbolicate", { method: "POST" });
      await fetch("http://localhost:8081/__sentry/context", { method: "POST" });
      await fetch(`${BACKEND}/symbolicate-not`);
      await rum.flush();
      expect(captured.spans.map((s) => attr(s.attributes, "url.full"))).toEqual([`${BACKEND}/symbolicate-not`]);
      expect(captured.byName("http.request")).toHaveLength(1);
    } finally {
      delete dev.__DEV__;
    }
  });
});
