/**
 * Fault injection (spec section 14, method F; ERR-1, ERR-2, ERR-3, ERR-5, ERR-6; ADR-0021
 * decision 4). Every seam where SDK code runs on behalf of the host gets a fault, and each test
 * asserts that (a) nothing reaches the host, (b) patched fetch / XHR give exactly what the
 * unpatched one gives, (c) the previous global error handler and the rejection forwarding still
 * run, (d) past the threshold the SDK disables itself and stops emitting.
 *
 * Vitest fails the run on any uncaught exception or unhandled rejection, so "nothing reaches the
 * host" also covers what a timer or a promise would throw after the test body returned.
 */
import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guard, guardNative } from "../src/guard";
import * as sdk from "../src/index";
import { initRUM, navigationStateListener, RUMProvider, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { SessionManager } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import { OutboxExporter } from "../src/transport/exporter";
import type { Outbox } from "../src/transport/outbox";
import type { AsyncKeyValueStorage, RUMOptions } from "../src/types";
import { AppState } from "./mocks/react-native";
import { attr, BACKEND, baseOptions, g, installErrorUtils, installFetchStub, sleep, type Captured } from "./support/otlp";

/**
 * The seams. `covered by` names the test below that injects a fault there; the last test of the
 * file fails when a row has no test. That a new timer or listener in `src/` is guarded at all is
 * checked against the source by test/hardening.test.ts ("every timer, frame and listener ...").
 */
const SEAMS: ReadonlyArray<readonly [seam: string, fault: string, coveredBy: string]> = [
  ["public API: every function", "malformed arguments (undefined, null, cyclic, huge, non-Error throws)", "public API: malformed inputs"],
  ["public API: every function", "SDK internals throw (Date.now)", "public API: internals throw"],
  ["public API: before init, after shutdown, no-op instance", "called at the wrong time", "public API: before init and after shutdown"],
  ["init", "options that throw when read, wrong types", "init: hostile options"],
  ["patched fetch", "SDK code inside it throws", "fetch parity"],
  ["patched XMLHttpRequest", "SDK code inside it throws", "XHR parity"],
  ["global error handler", "SDK code inside it throws", "global handler chains"],
  ["promise rejection tracker", "SDK code throws, app callback throws", "rejection forwarding"],
  ["console.error patch", "SDK code inside it throws", "console patch"],
  ["timers and intervals", "Date.now throws while timers fire", "timers and listeners"],
  ["AppState listener", "SDK code inside it throws", "timers and listeners"],
  ["navigation listener", "SDK code inside it throws, malformed state", "timers and listeners"],
  ["touch listeners (RUMProvider)", "SDK code inside them throws, malformed events", "timers and listeners"],
  ["OTel processors (onEmit, onStart, onEnd)", "session lookup throws inside the processor", "processors and exporters"],
  ["exporter", "serializer throws, outbox rejects", "processors and exporters"],
  ["send", "fetch to the collector throws synchronously", "storage, send and outbox"],
  ["outbox and storage callbacks", "storage throws synchronously, rejects, returns garbage", "storage, send and outbox"],
  ["beforeSend", "the hook throws", "app callbacks"],
  ["onUnhandledRejection", "the app callback throws", "rejection forwarding"],
  ["sanitizeUrl", "the app callback throws", "app callbacks"],
  ["debug logger", "console.log and console.warn throw", "logger"],
  ["native module: every method", "every method throws / rejects", "native module"],
  ["native replay: start (OTLP options)", "throws, rejects, returns garbage", "native module"],
  ["native replay: capture(trigger)", "throws on the first unhandled error and on replay.capture()", "native module"],
  ["native replay: setViewId, screenDidChange", "throw on every navigation", "native module"],
  ["native replay: mask, unmask", "throw; refs that are not views", "native module"],
  ["native replay: sessionDidRotate", "throws on restartSession", "native module"],
  ["native replay: endSession, flush", "throw / reject on shutdown", "native module"],
  ["native replay: stop, discardPending", "throw / reject on consent withdrawal and self-disable", "native module"],
  ["native replay: replayDiagnostics", "throws", "native module"],
  ["native module: callbacks", "onHang delivers garbage", "native module"],
  ["native module: missing or half-present", "no module, only start()", "native module"],
  ["self-disable", "more internal errors than the threshold", "self-disable"],
  ["guard reporting", "the logger throws while an error is reported", "self-disable"],
];
const covered = new Set<string>();
const seamTest = (name: string, fn: () => unknown): void => {
  covered.add(name);
  it(name, fn as () => void);
};

let originalFetch: typeof fetch;
let defaultHandlerCalls: Array<[unknown, boolean | undefined]>;
const originalConsoleError = console.error;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  defaultHandlerCalls = installErrorUtils();
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  await sdk.shutdown();
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  delete g.ErrorUtils;
  delete g.HermesInternal;
  delete g.__ouoSessionProcessState;
  delete g.expo;
  delete (globalThis as { __SENTRY__?: unknown }).__SENTRY__;
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
});

async function start(extra: Partial<RUMOptions> = {}): Promise<{ rum: RUMInternal; captured: Captured; stub: typeof fetch }> {
  const captured = installFetchStub();
  const stub = globalThis.fetch;
  const rum = initRUM({ ...baseOptions(new MemoryAsyncStorage()), ...extra } as RUMOptions) as RUMInternal;
  await rum.ready;
  return { rum, captured, stub };
}

/** From here every SDK code path that reads the clock throws: the cheapest fault that reaches all of them. */
function breakClock(): void {
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("injected: Date.now");
  });
}

const cyclic: Record<string, unknown> = { a: 1 };
cyclic["self"] = cyclic;
const hostile = {
  get boom(): never {
    throw new Error("injected: getter");
  },
  toString(): never {
    throw new Error("injected: toString");
  },
};
const HUGE = "x".repeat(2_000_000);
const MALFORMED: unknown[] = [undefined, null, cyclic, HUGE, 42, NaN, true, [], () => 1, Symbol("s"), hostile, new Error("e"), "", { id: cyclic }];

/** Every public function of an instance, with the number of arguments it takes. */
function publicCalls(rum: RUMInternal): Array<[string, (...a: unknown[]) => unknown, number]> {
  const r = rum as unknown as Record<string, (...a: unknown[]) => unknown>;
  const replay = rum.replay as unknown as Record<string, (...a: unknown[]) => unknown>;
  const session = rum.session as unknown as Record<string, (...a: unknown[]) => unknown>;
  const log = rum.log as unknown as Record<string, (...a: unknown[]) => unknown> & ((...a: unknown[]) => unknown);
  return [
    ["setUser", r["setUser"]!, 1],
    ["setConsent", r["setConsent"]!, 1],
    ["setGlobalAttributes", r["setGlobalAttributes"]!, 1],
    ["recordException", r["recordException"]!, 2],
    ["captureError", r["captureError"]!, 2],
    ["recordEvent", r["recordEvent"]!, 3],
    ["addEvent", r["addEvent"]!, 2],
    ["trackNavigation", r["trackNavigation"]!, 2],
    ["recordActivity", r["recordActivity"]!, 0],
    ["trackTap", r["trackTap"]!, 3],
    ["reportFullyDisplayed", r["reportFullyDisplayed"]!, 0],
    ["startSpan", r["startSpan"]!, 2],
    ["log", log, 4],
    ["log.info", log["info"]!, 3],
    ["log.error", log["error"]!, 3],
    ["feedback", r["feedback"]!, 1],
    ["flush", r["flush"]!, 0],
    ["getSessionId", r["getSessionId"]!, 0],
    ["restartSession", r["restartSession"]!, 0],
    ["getTracerProvider", r["getTracerProvider"]!, 0],
    ["getLoggerProvider", r["getLoggerProvider"]!, 0],
    ["_rootMounted", r["_rootMounted"]!, 0],
    ["_touchStart", r["_touchStart"]!, 2],
    ["_touchEnd", r["_touchEnd"]!, 1],
    ...["pause", "resume", "isRecording", "hideScreen", "showScreen", "start", "stop", "capture"].map((m): [string, (...a: unknown[]) => unknown, number] => [`replay.${m}`, replay[m]!, 0]),
    ["replay.mask", replay["mask"]!, 1],
    ["replay.unmask", replay["unmask"]!, 1],
    ["session.id", session["id"]!, 0],
    ["session.userId", session["userId"]!, 0],
    ["session.previousId", session["previousId"]!, 0],
  ];
}

/** Calls every public function with every malformed value in every argument position. */
async function callEverything(rum: RUMInternal, values: unknown[] = MALFORMED): Promise<void> {
  for (const [name, fn, arity] of publicCalls(rum)) {
    const argSets: unknown[][] = arity === 0 ? [[]] : values.flatMap((v) => Array.from({ length: arity }, (_, i) => Array.from({ length: arity }, (_, j) => (j === i ? v : j === 0 ? "ok" : undefined))));
    for (const args of argSets) {
      let result: unknown;
      expect(() => (result = fn(...args)), `${name}(${args.map((a) => typeof a).join(", ")})`).not.toThrow();
      if (result && typeof (result as Promise<unknown>).then === "function") await expect(result as Promise<unknown>).resolves.not.toThrow();
    }
  }
  // withSpan runs the app's function whatever the SDK's state, and only the app's errors come out.
  for (const v of values) {
    expect(() => rum.withSpan(v as string, () => 1, v as never)).not.toThrow();
    expect(() => rum.withSpan("x", v as never)).not.toThrow();
  }
  expect(rum.withSpan("ok", () => 7)).toBe(7);
  const boom = new Error("the app's own error");
  expect(() =>
    rum.withSpan("x", () => {
      throw boom;
    }),
  ).toThrow(boom);
  await expect(rum.withSpan("x", () => Promise.reject(boom))).rejects.toBe(boom);
  await expect(rum.ready).resolves.toBeUndefined();
}

describe("fault injection: nothing the SDK does reaches the host", () => {
  seamTest("public API: malformed inputs", async () => {
    const { rum } = await start();
    await callEverything(rum);
    // A malformed argument is the app's mistake, not an SDK failure: it does not move the SDK towards self-disable.
    expect(guard.errors).toBe(0);
    expect(guard.disabled).toBe(false);
    // Non-Error throws through every error entry point.
    for (const thrown of ["a string", 0, null, undefined, cyclic, Symbol("s"), hostile]) {
      expect(() => g.ErrorUtils!.getGlobalHandler()(thrown, false)).not.toThrow();
      expect(() => console.error(thrown)).not.toThrow();
      expect(() => rum.recordException(thrown)).not.toThrow();
    }
    await rum.flush();
    expect(guard.disabled).toBe(false);
  });

  seamTest("public API: internals throw", async () => {
    const { rum } = await start({ diagnostics: { selfDisableThreshold: 1_000_000 } });
    breakClock();
    await callEverything(rum, [undefined, "ok", { a: 1 }]);
    expect(guard.errors).toBeGreaterThan(0);
    expect(guard.disabled).toBe(false);
  });

  seamTest("public API: before init and after shutdown", async () => {
    // Before init: the module-level API.
    expect(getRUM()).toBeUndefined();
    const moduleCalls = (): void => {
      for (const v of MALFORMED) {
        expect(() => {
          sdk.setUser(v as never);
          sdk.setConsent(v as never);
          sdk.setGlobalAttributes(v as never);
          sdk.recordEvent(v as never, v as never, v as never);
          sdk.recordException(v, v as never);
          sdk.trackNavigation(v as never, v as never);
          sdk.restartSession();
          sdk.replay.start();
          sdk.replay.stop();
          sdk.replay.capture();
          sdk.replay.mask(v);
          sdk.replay.unmask(v);
          sdk.getTracerProvider().getTracer("app").startSpan("x").end();
          sdk.getLoggerProvider().getLogger("app").emit({ body: "x" });
          navigationStateListener(v as never)(v as never);
        }).not.toThrow();
      }
      expect(sdk.getSessionId()).toBeUndefined();
    };
    moduleCalls();
    await expect(sdk.flush()).resolves.toBeUndefined();
    await expect(sdk.shutdown()).resolves.toBeUndefined();

    // The no-op instance of an invalid configuration.
    const noop = initRUM({ endpoint: "nope" } as unknown as RUMOptions) as RUMInternal;
    expect(getRUM()).toBeUndefined();
    await callEverything(noop);

    // After shutdown: the instance and the module-level API.
    const { rum, captured } = await start();
    expect(sdk.getSessionId()).toBe(rum.session.id());
    await rum.shutdown();
    const sent = captured.logs.length;
    await callEverything(rum);
    moduleCalls();
    await sleep(20);
    expect(captured.logs.length).toBe(sent);
    await expect(rum.shutdown()).resolves.toBeUndefined();
  });

  seamTest("init: hostile options", () => {
    installFetchStub();
    const before = globalThis.fetch;
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("injected: option getter");
        },
      },
    );
    for (const options of [...MALFORMED, throwing]) {
      let rum: unknown;
      expect(() => (rum = initRUM(options as never))).not.toThrow();
      expect((rum as RUMInternal).getSessionId()).toBeUndefined();
    }
    // Valid required options, garbage everywhere else: the SDK starts and falls back to defaults.
    for (const junk of [null, 42, "x", cyclic, [], () => 1]) {
      const rum = initRUM({
        ...baseOptions(),
        tracing: junk,
        replay: junk,
        session: junk,
        user: junk,
        device: junk,
        resource: junk,
        errors: junk,
        timeline: junk,
        vitals: junk,
        transport: junk,
        storage: junk,
        beforeSend: junk,
        diagnostics: junk,
        otel: junk,
        debug: junk,
      } as unknown as RUMOptions) as RUMInternal;
      expect(typeof rum.getSessionId()).toBe("string");
      void rum._uninstall();
      expect(() => initRUM({ ...baseOptions(), tracing: { propagateTo: junk, ignoreUrls: junk }, session: { sampleRate: junk, maxDurationMs: junk } } as unknown as RUMOptions)).not.toThrow();
      void (getRUM() as RUMInternal)._uninstall();
    }
    expect(before).toBeDefined();
  });

  seamTest("fetch parity", async () => {
    const { stub } = await start({ diagnostics: { selfDisableThreshold: 1_000_000 } });
    expect(globalThis.fetch).not.toBe(stub);
    const unpatched = async (url: string): Promise<{ value?: Response; error?: unknown }> => stub(url).then((value) => ({ value }), (error: unknown) => ({ error }));
    const patched = async (url: string): Promise<{ value?: Response; error?: unknown }> => fetch(url).then((value) => ({ value }), (error: unknown) => ({ error }));

    for (const broken of [false, true]) {
      if (broken) breakClock();
      const ok = await patched(`${BACKEND}/api/products`);
      const okPlain = await unpatched(`${BACKEND}/api/products`);
      expect(ok.value?.status).toBe(okPlain.value?.status);
      expect(await ok.value!.text()).toBe(await okPlain.value!.text());
      // Rejection: the same error type and message, not wrapped.
      const down = await patched(`${BACKEND}/network-down`);
      const downPlain = await unpatched(`${BACKEND}/network-down`);
      expect(down.error).toBeInstanceOf(TypeError);
      expect((down.error as Error).message).toBe((downPlain.error as Error).message);
      // Status codes pass through untouched.
      expect((await patched(`${BACKEND}/x?fail=500`)).value?.status).toBe(500);
      expect((await patched(`${BACKEND}/missing`)).value?.status).toBe(404);
    }
    expect(guard.errors).toBeGreaterThan(0);

    // Identity and ordering against a fetch the test controls.
    await (getRUM() as RUMInternal)._uninstall();
    vi.restoreAllMocks();
    const order: string[] = [];
    const response = new Response("same object");
    const failure = { not: "an Error" };
    const calls: unknown[][] = [];
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      order.push("original called");
      return String(args[0]).includes("reject") ? Promise.reject(failure) : Promise.resolve(response);
    }) as typeof fetch;
    const rum = initRUM({ ...baseOptions(), tracing: {}, diagnostics: { selfDisableThreshold: 1_000_000 } }) as RUMInternal;
    await rum.ready;
    for (const broken of [false, true]) {
      if (broken) breakClock();
      const init = { method: "POST", headers: { "x-app": "1" } };
      const p = fetch("http://app.test/a", init);
      order.push("fetch returned");
      expect(await p).toBe(response);
      // No propagation target: the app's own arguments reach the original untouched.
      expect(calls.at(-1)![0]).toBe("http://app.test/a");
      expect(calls.at(-1)![1]).toBe(init);
      await expect(fetch("http://app.test/reject")).rejects.toBe(failure);
    }
    // The original is called synchronously inside the patched call, as an unpatched fetch would be.
    expect(order.slice(0, 2)).toEqual(["original called", "fetch returned"]);
  });

  seamTest("XHR parity", async () => {
    const log: string[] = [];
    class FakeXHR {
      status = 0;
      listeners: Record<string, Array<() => void>> = {};
      open(method: string, url: string): void {
        log.push(`open ${method} ${url}`);
        if (url.includes("bad-open")) throw new SyntaxError("injected: open");
      }
      setRequestHeader(name: string, value: string): void {
        log.push(`header ${name}=${value}`);
      }
      addEventListener(type: string, fn: () => void): void {
        (this.listeners[type] ??= []).push(fn);
      }
      send(body?: unknown): string {
        log.push(`send ${String(body)}`);
        if (String(body) === "throw") throw new RangeError("injected: send");
        this.status = 200;
        for (const fn of this.listeners["loadend"] ?? []) fn();
        return "send result";
      }
    }
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
    const run = (): unknown[] => {
      log.length = 0;
      const out: unknown[] = [];
      const xhr = new FakeXHR();
      out.push(xhr.open("GET", "http://app.test/a"));
      out.push(xhr.setRequestHeader("x-app", "1"));
      out.push(xhr.send("body"));
      const failing = new FakeXHR();
      failing.open("POST", "http://app.test/b");
      try {
        failing.send("throw");
      } catch (e) {
        out.push(e);
      }
      try {
        new FakeXHR().open("GET", "http://app.test/bad-open");
      } catch (e) {
        out.push(e);
      }
      // send without open, the app's own misuse: the original decides.
      out.push(new FakeXHR().send("no open"));
      return [...out.map((o) => (o instanceof Error ? `${o.name}: ${o.message}` : o)), ...log];
    };
    const unpatched = run();
    await start({ tracing: {}, diagnostics: { selfDisableThreshold: 1_000_000 } });
    expect(FakeXHR.prototype.send.name).toBe("ouoSend");
    expect(run()).toEqual(unpatched);
    breakClock();
    expect(run()).toEqual(unpatched);
    expect(guard.errors).toBeGreaterThan(0);
  });

  seamTest("global handler chains", async () => {
    await start({ diagnostics: { selfDisableThreshold: 1_000_000 } });
    const errorEvent = new Event("error"); // jsdom reads the clock to make one
    breakClock();
    const handler = g.ErrorUtils!.getGlobalHandler();
    const nonFatal = new Error("non fatal");
    expect(() => handler(nonFatal, false)).not.toThrow();
    // The previous handler ran, synchronously, with the same arguments.
    expect(defaultHandlerCalls).toEqual([[nonFatal, false]]);
    const fatal = new Error("fatal");
    expect(() => handler(fatal, true)).not.toThrow();
    await sleep(10);
    expect(defaultHandlerCalls).toEqual([
      [nonFatal, false],
      [fatal, true],
    ]);
    // Exactly once each, also for a value that is not an Error.
    handler("a string", true);
    await sleep(10);
    expect(defaultHandlerCalls).toHaveLength(3);
    // The browser `error` event listener (Expo web) does not throw either.
    expect(() => (globalThis as unknown as EventTarget).dispatchEvent(errorEvent)).not.toThrow();
  });

  seamTest("rejection forwarding", async () => {
    let tracker: { onUnhandled: (id: number, e: unknown) => void } | undefined;
    g.HermesInternal = { hasPromise: () => true, enablePromiseRejectionTracker: (o: typeof tracker) => (tracker = o) };
    const seen: unknown[] = [];
    // The app's callback throws, and SDK code throws: the rejection still reaches the callback.
    await start({
      diagnostics: { selfDisableThreshold: 1_000_000 },
      errors: {
        onUnhandledRejection: (e) => {
          seen.push(e);
          throw new Error("injected: app callback");
        },
      },
    });
    const before = guard.errors;
    const first = new Error("rejected");
    expect(() => tracker!.onUnhandled(1, first)).not.toThrow();
    // The app's own callback throwing is not an SDK error.
    expect(guard.errors).toBe(before);
    breakClock();
    expect(() => tracker!.onUnhandled(2, "not an error")).not.toThrow();
    expect(() => tracker!.onUnhandled(3, undefined)).not.toThrow();
    expect(seen).toEqual([first, "not an error", undefined]);

    // Without a callback the rejection goes to Sentry's scope (what Sentry's replaced tracker did), even when SDK code throws.
    await (getRUM() as RUMInternal)._uninstall();
    vi.restoreAllMocks();
    const captureException = vi.fn();
    (globalThis as { __SENTRY__?: unknown }).__SENTRY__ = { "10.0.0": { defaultCurrentScope: { getClient: () => ({}), captureException } } };
    await start({ diagnostics: { selfDisableThreshold: 1_000_000 } });
    breakClock();
    const second = new Error("for sentry");
    expect(() => tracker!.onUnhandled(4, second)).not.toThrow();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![0]).toBe(second);
  });

  seamTest("console patch", async () => {
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => void calls.push(args);
    const unpatched = console.error;
    await start({ diagnostics: { selfDisableThreshold: 1_000_000 } });
    expect(console.error).not.toBe(unpatched);
    breakClock();
    const err = new Error("logged");
    expect(() => console.error("message", err, cyclic)).not.toThrow();
    expect(() => console.error()).not.toThrow();
    // The app's console.error ran first, with the app's arguments.
    expect(calls).toEqual([["message", err, cyclic], []]);
    expect(guard.errors).toBeGreaterThan(0);
  });

  seamTest("timers and listeners", async () => {
    const { rum } = await start({ diagnostics: { selfDisableThreshold: 1_000_000 }, replay: { enabled: true, excludeScreens: ["Secret"] } });
    rum.trackNavigation("/Secret");
    rum.trackNavigation("/Home");
    rum.log.info("starts the context timer");
    breakClock();
    // AppState listener.
    expect(() => {
      AppState.__emit("inactive");
      AppState.__emit("background");
      AppState.__emit("active");
    }).not.toThrow();
    // Navigation listener, with malformed states.
    const onState = navigationStateListener(rum);
    for (const state of [undefined, null, { routes: [{ name: "A", state: cyclic }] }, cyclic, 42, { routes: "x" }]) expect(() => onState(state as never)).not.toThrow();
    // Touch listeners of the provider, with malformed events.
    const props = RUMProvider({ rum }).props as { onTouchStart: (e: unknown) => void; onTouchEnd: (e: unknown) => void; onTouchCancel: (e: unknown) => void; ref: (n: unknown) => void };
    for (const event of [undefined, null, {}, { nativeEvent: null }, { _targetInst: cyclic, nativeEvent: { touches: "x" } }, hostile]) {
      expect(() => {
        props.onTouchStart(event);
        props.onTouchEnd(event);
        props.onTouchCancel(event);
      }).not.toThrow();
    }
    expect(() => props.ref({})).not.toThrow();
    expect(() => props.ref(null)).not.toThrow();
    // Timers: the stall timer (50 ms), the replay show timer (500 ms), the drop report (1 s), batch timers.
    await sleep(1200);
    expect(guard.errors).toBeGreaterThan(0);
  });

  seamTest("processors and exporters", async () => {
    const { rum, captured } = await start({ diagnostics: { selfDisableThreshold: 1_000_000 } });
    for (const method of ["id", "userId", "peek"] as const) {
      vi.spyOn(SessionManager.prototype, method).mockImplementation(() => {
        throw new Error(`injected: session.${method}`);
      });
    }
    // Records made by the host on the SDK's providers: the processors fail (the session lookup
    // throws), the host's calls do not.
    expect(() => {
      rum.getLoggerProvider().getLogger("app").emit({ body: "host record" });
      const span = rum.getTracerProvider().getTracer("app").startSpan("host span");
      span.end();
    }).not.toThrow();
    expect(guard.errors).toBeGreaterThan(0);
    vi.restoreAllMocks();
    await rum.flush();
    expect(captured.logs.some((l) => l.body?.stringValue === "host record")).toBe(false);

    // The exporter: a serializer that throws and an outbox that rejects fail the export, nothing more.
    const outbox = { put: () => Promise.reject(new Error("injected: outbox")) } as unknown as Outbox;
    const results: number[] = [];
    const throwing = new OutboxExporter<number>({ serializeRequest: () => { throw new Error("injected: serializer"); } }, "http://c/v1/logs", outbox);
    expect(() => throwing.export([1], (r) => results.push(r.code))).not.toThrow();
    const rejecting = new OutboxExporter<number>({ serializeRequest: () => new Uint8Array([123, 125]) }, "http://c/v1/logs", outbox);
    expect(() => rejecting.export([1], (r) => results.push(r.code))).not.toThrow();
    await sleep(5);
    expect(results).toEqual([ExportResultCode.FAILED, ExportResultCode.FAILED]);
  });

  seamTest("storage, send and outbox", async () => {
    const storages: Record<string, AsyncKeyValueStorage> = {
      "throws synchronously": {
        getItem: () => {
          throw new Error("injected: getItem");
        },
        setItem: () => {
          throw new Error("injected: setItem");
        },
        removeItem: () => {
          throw new Error("injected: removeItem");
        },
      },
      rejects: { getItem: () => Promise.reject(new Error("injected")), setItem: () => Promise.reject(new Error("injected")), removeItem: () => Promise.reject(new Error("injected")) },
      "returns garbage": { getItem: () => Promise.resolve("{not json") as Promise<string>, setItem: () => undefined as unknown as Promise<void>, removeItem: () => 42 as unknown as Promise<void> },
      "returns the wrong shapes": { getItem: () => Promise.resolve('{"next":"x","items":7}'), setItem: () => Promise.resolve(), removeItem: () => Promise.resolve() },
    };
    for (const [name, storage] of Object.entries(storages)) {
      const captured = installFetchStub();
      const rum = initRUM({ ...baseOptions(), storage }) as RUMInternal;
      await rum.ready;
      rum.recordEvent("survives.storage");
      rum.setUser("u-1");
      await rum.flush();
      // Persistence failed, delivery from memory did not (TRN-15).
      expect(captured.byName("survives.storage"), name).toHaveLength(1);
      // A storage that fails is the environment's failure, not an SDK error.
      expect(guard.disabled, name).toBe(false);
      await rum._uninstall();
      delete g.__ouoSessionProcessState;
    }

    // send: the collector request throws synchronously, rejects, answers garbage.
    for (const answer of [
      () => {
        throw new Error("injected: fetch throws");
      },
      () => Promise.reject(new Error("injected: fetch rejects")),
      () => Promise.resolve(undefined),
      () => Promise.resolve({ status: "nope" }),
    ]) {
      globalThis.fetch = ((url: string) => (String(url).startsWith("http://otel.test") ? answer() : Promise.resolve(new Response("[]")))) as unknown as typeof fetch;
      const rum = initRUM(baseOptions()) as RUMInternal;
      await rum.ready;
      rum.recordEvent("unsendable");
      await expect(rum.flush()).resolves.toBeUndefined();
      await expect(fetch(`${BACKEND}/app`)).resolves.toBeInstanceOf(Response);
      await rum._uninstall();
      delete g.__ouoSessionProcessState;
    }
  });

  seamTest("app callbacks", async () => {
    const seen: string[] = [];
    const { rum, captured } = await start({
      beforeSend: (record) => {
        seen.push(record.name);
        // Mutates its copy, then throws: the unmodified record goes on (CFG-4).
        record.attributes["leak"] = "should not be sent";
        throw new Error("injected: beforeSend");
      },
      sanitizeUrl: () => {
        throw new Error("injected: sanitizeUrl");
      },
    });
    const before = guard.errors;
    rum.recordEvent("kept", { a: 1 });
    rum.startSpan("kept span").end();
    await rum.flush();
    expect(seen).toContain("kept");
    expect(seen).toContain("kept span");
    const kept = captured.byName("kept")[0]!;
    expect(attr(kept.attributes, "a")).toBe(1);
    expect(attr(kept.attributes, "leak")).toBeUndefined();
    expect(captured.spans.some((s) => s.name === "kept span")).toBe(true);
    // The app's callbacks throwing are not SDK errors.
    expect(guard.errors).toBe(before);
  });

  seamTest("logger", async () => {
    const throwingConsole = (): never => {
      throw new Error("injected: console");
    };
    vi.spyOn(console, "log").mockImplementation(throwingConsole);
    vi.spyOn(console, "warn").mockImplementation(throwingConsole);
    // With debug on, every diagnostic throws: init, every call and every hook still work.
    const captured = installFetchStub();
    let rum!: RUMInternal;
    expect(() => (rum = initRUM({ ...baseOptions(), debug: true, diagnostics: { selfDisableThreshold: 1_000_000 } }) as RUMInternal)).not.toThrow();
    await rum.ready;
    await callEverything(rum, [undefined, "ok"]);
    expect(() => g.ErrorUtils!.getGlobalHandler()(new Error("x"), false)).not.toThrow();
    await expect(fetch(`${BACKEND}/api`)).resolves.toBeInstanceOf(Response);
    await rum.flush();
    expect(captured.requests.length).toBeGreaterThan(0);
  });

  seamTest("native module", async () => {
    const methods = [
      "start", "pause", "resume", "isRecording", "flush", "sessionDidRotate", "setSessionId", "screenDidChange", "recoverPendingChunk", "stop",
      "capture", "setViewId", "mask", "unmask", "endSession", "discardPending", "replayDiagnostics", "installCrashReporter", "setCrashSessionId", "takePendingCrash",
      "getErrorContext", "getFrameStats", "getAppStartInfo", "postOtlp",
    ];
    let hang: ((payload: unknown) => void) | undefined;
    const variants: Record<string, Record<string, unknown> | undefined> = {
      "every method throws": Object.fromEntries(methods.map((m) => [m, () => { throw new Error(`injected: native ${m}`); }])),
      "every method rejects": Object.fromEntries(methods.map((m) => [m, () => Promise.reject(new Error(`injected: native ${m}`))])),
      "every method returns garbage": { ...Object.fromEntries(methods.map((m) => [m, () => cyclic])), addListener: (_e: string, cb: (p: unknown) => void) => ((hang = cb), { remove: () => { throw new Error("injected: remove"); } }) },
      "half present: only start()": { start: () => undefined },
      "not functions": Object.fromEntries(methods.map((m) => [m, 42])),
      missing: undefined,
    };
    for (const [name, native] of Object.entries(variants)) {
      g.expo = native ? { modules: { OuoReplay: native } } : { modules: {} };
      const captured = installFetchStub();
      let rum!: RUMInternal;
      expect(() => (rum = initRUM({ ...baseOptions(), replay: { enabled: true, onErrorSampleRate: 1 }, diagnostics: { selfDisableThreshold: 1_000_000 } }) as RUMInternal), name).not.toThrow();
      await rum.ready;
      await callEverything(rum, [undefined, "ok"]);
      rum.recordException(new Error("needs the native error context"));
      // Every replay call: the first unhandled error (capture), navigation (setViewId), masks,
      // a rotation, consent withdrawn (stop, discardPending) and given again, then shutdown below.
      g.ErrorUtils!.getGlobalHandler()(new Error("sends the buffer"), false);
      rum.trackNavigation("/A");
      rum.trackNavigation("/B");
      for (const target of [7, { current: { __tag: 9 } }, { current: null }, {}, "x"]) {
        rum.replay.mask(target);
        rum.replay.unmask(target);
      }
      rum.replay.capture();
      rum.restartSession();
      rum.setConsent({ replay: false });
      rum.setConsent({ replay: true });
      AppState.__emit("background");
      AppState.__emit("active");
      // A native callback that delivers garbage.
      for (const payload of [undefined, null, {}, { report: "{not json" }, { report: 42 }, cyclic]) expect(() => hang?.(payload), name).not.toThrow();
      await expect(rum.flush(), name).resolves.toBeUndefined();
      await expect(fetch(`${BACKEND}/api`), name).resolves.toBeInstanceOf(Response);
      // Without a usable postOtlp the JS transport carries the telemetry; with a broken one nothing throws.
      if (!native || typeof native["postOtlp"] !== "function") expect(captured.byName("exception").length, name).toBeGreaterThan(0);
      await expect(rum.shutdown(), name).resolves.toBeUndefined();
      hang = undefined;
      delete g.__ouoSessionProcessState;
    }
    // The guard around a native module: feature detection still works, calls never throw.
    const wrapped = guardNative({ boom: () => { throw new Error("x"); }, value: 7, later: () => Promise.reject(new Error("y")) })!;
    expect(typeof wrapped.boom).toBe("function");
    expect(wrapped.value).toBe(7);
    expect((wrapped as { nope?: unknown }).nope).toBeUndefined();
    expect(() => wrapped.boom()).not.toThrow();
    await expect(wrapped.later()).resolves.toBeUndefined();
    expect(guardNative(undefined)).toBeUndefined();
  });

  seamTest("self-disable", async () => {
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => void calls.push(args);
    const appConsoleError = console.error;
    const previousHandler = g.ErrorUtils!.getGlobalHandler();
    // The logger throws too: reporting an internal error must not loop or throw (ERR-5).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("injected: console.warn");
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { rum, captured, stub } = await start({ debug: true, diagnostics: { selfDisableThreshold: 5 } });
    rum.recordEvent("before");
    await rum.flush();
    expect(captured.byName("before")).toHaveLength(1);
    expect(globalThis.fetch).not.toBe(stub);

    breakClock();
    for (let i = 0; i < 4; i++) rum.recordEvent(`fails ${i}`);
    expect(guard.errors).toBe(4);
    expect(guard.disabled).toBe(false);
    rum.recordEvent("the fifth");
    expect(guard.disabled).toBe(true);
    // One diagnostic per error plus the self-disable notice, not a loop.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(8);
    vi.restoreAllMocks();

    // Every hook is gone: the globals are the ones from before init.
    expect(globalThis.fetch).toBe(stub);
    expect(console.error).toBe(appConsoleError);
    expect(g.ErrorUtils!.getGlobalHandler()).toBe(previousHandler);
    expect(getRUM()).toBeUndefined();

    // Every public function is a no-op, nothing is emitted any more, and no error is counted.
    const sent = captured.logs.length + captured.spans.length;
    const errors = guard.errors;
    await callEverything(rum);
    rum.getLoggerProvider().getLogger("app").emit({ body: "after disable" });
    AppState.__emit("background");
    AppState.__emit("active");
    await fetch(`${BACKEND}/api`);
    console.error(new Error("after disable"));
    await sleep(1100);
    await rum.flush();
    expect(captured.logs.length + captured.spans.length).toBe(sent);
    expect(guard.errors).toBe(errors);
    expect(rum.getSessionId()).toBeUndefined();
    await expect(rum.shutdown()).resolves.toBeUndefined();

    // LIF-5: a new init is a new start, with the count back at zero.
    const again = initRUM(baseOptions()) as RUMInternal;
    await again.ready;
    expect(guard.disabled).toBe(false);
    expect(guard.errors).toBe(0);
    again.recordEvent("after re-init");
    await again.flush();
    expect(captured.byName("after re-init")).toHaveLength(1);
  });

  it("the seam table has a test for every row", () => {
    for (const [seam, , coveredBy] of SEAMS) expect(covered.has(coveredBy), `${seam}: ${coveredBy}`).toBe(true);
  });
});
