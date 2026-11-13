/**
 * Regressions from the review of ADR-0021 step A (PR 183): the previous global handler under a
 * hung storage, consent transitions that race, uninstall next to another SDK's patches,
 * `beforeSend` re-entry, self-disable during init, the consent overlay's size, the bypass cap for
 * fatal JS errors, and the private OTel fields the queue-full count reads.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BatchLogRecordProcessor, type SdkLogRecord } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guard } from "../src/guard";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { SampledLogProcessor } from "../src/sampling";
import { SESSION_STORAGE_KEY } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import type { RUMOptions } from "../src/types";
import { AppState } from "./mocks/react-native";
import { BACKEND, baseOptions, g, installErrorUtils, installFetchStub, sleep, type Captured } from "./support/otlp";

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
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  delete g.ErrorUtils;
  delete g.__ouoSessionProcessState;
  delete g.expo;
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
});

async function start(extra: Partial<RUMOptions> = {}, storage = new MemoryAsyncStorage()): Promise<{ rum: RUMInternal; captured: Captured; stub: typeof fetch }> {
  const captured = installFetchStub();
  const stub = globalThis.fetch;
  const rum = initRUM({ ...baseOptions(storage), ...extra } as RUMOptions) as RUMInternal;
  await rum.ready;
  return { rum, captured, stub };
}

describe("the previous global handler always runs (ERR-3)", () => {
  it("a fatal error reaches the previous handler even when the storage write hangs", async () => {
    const storage = new MemoryAsyncStorage();
    await start({ errors: { fatalFlushTimeoutMs: 300 } }, storage);
    storage.setItem = () => new Promise<void>(() => undefined); // AsyncStorage stops answering
    const fatal = new Error("fatal");
    g.ErrorUtils!.getGlobalHandler()(fatal, true);
    await sleep(100);
    expect(defaultHandlerCalls).toEqual([]); // still within the bound
    await sleep(600);
    expect(defaultHandlerCalls).toEqual([[fatal, true]]);
  });
});

describe("consent transitions are serialised (PRV-4)", () => {
  it("deny then grant right away: storage persists again", async () => {
    const storage = new MemoryAsyncStorage();
    const { rum } = await start({}, storage);
    rum.setConsent({ telemetry: false });
    rum.setConsent({ telemetry: true });
    await sleep(200);
    rum.recordActivity();
    rum.recordEvent("b");
    await rum.flush();
    expect(storage.peek(SESSION_STORAGE_KEY)).not.toBeNull();
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).id).toBe(rum.getSessionId());
  });

  it("pending -> grant -> deny with a slow storage: nothing stays on the device", async () => {
    const storage = new MemoryAsyncStorage();
    const set = storage.setItem.bind(storage);
    storage.setItem = async (k, v) => {
      await sleep(20);
      return set(k, v);
    };
    installFetchStub();
    const rum = initRUM({ ...baseOptions(storage), consent: { required: true } } as RUMOptions) as RUMInternal;
    await rum.ready;
    for (let i = 0; i < 5; i++) rum.recordEvent(`e${i}`);
    await sleep(1200);
    rum.setConsent({ telemetry: true });
    rum.setConsent({ telemetry: false });
    await sleep(1500);
    const left = ["ouo.session", "ouo.user", "ouo.context", "ouo.outbox", ...Array.from({ length: 20 }, (_, i) => `ouo.outbox.${i + 1}`)].filter((k) => storage.peek(k) !== null);
    expect(left).toEqual([]);
  }, 10_000);

  it("deny, grant, deny in one tick ends denied with nothing on the device; grant, deny, grant ends granted and persistent", async () => {
    const storage = new MemoryAsyncStorage();
    const { rum, captured } = await start({}, storage);
    rum.setConsent({ telemetry: false });
    rum.setConsent({ telemetry: true });
    rum.setConsent({ telemetry: false });
    await sleep(100);
    rum.recordActivity();
    rum.recordEvent("while.denied");
    await rum.flush();
    expect(rum.getSessionId()).toBeUndefined();
    expect(storage.peek(SESSION_STORAGE_KEY)).toBeNull();

    rum.setConsent({ telemetry: true });
    rum.setConsent({ telemetry: false });
    rum.setConsent({ telemetry: true });
    await sleep(100);
    rum.recordActivity();
    rum.recordEvent("while.granted");
    await rum.flush();
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).id).toBe(rum.getSessionId());
    expect(captured.byName("while.granted")).toHaveLength(1);
    expect(captured.byName("while.denied")).toHaveLength(0);
    // Repeating the state it is in changes nothing.
    const id = rum.getSessionId();
    rum.setConsent({ telemetry: true });
    rum.setConsent({ telemetry: true });
    await sleep(20);
    expect(rum.getSessionId()).toBe(id);
  });

  it("telemetry denied: no session, no session id in baggage, whatever the activity", async () => {
    const captured = installFetchStub();
    const rum = initRUM({ ...baseOptions(), propagation: { sessionBaggage: true } } as RUMOptions) as RUMInternal;
    await rum.ready;
    rum.setConsent({ telemetry: false });
    rum.recordActivity();
    rum.trackNavigation("/Home");
    rum.trackTap("button");
    rum.restartSession();
    AppState.__emit("background");
    AppState.__emit("active");
    await fetch(`${BACKEND}/api`);
    expect(JSON.stringify(captured.requests.at(-1)!.headers)).not.toContain("session.id");
    expect(rum.getSessionId()).toBeUndefined();
    expect(rum.session.id()).toBe("");
  });

  it("the memory held while consent is pending does not grow with the requests that pass through the offline store", async () => {
    const storage = new MemoryAsyncStorage();
    const removed: string[] = [];
    const remove = storage.removeItem.bind(storage);
    storage.removeItem = (k) => {
      removed.push(k);
      return remove(k);
    };
    const { rum, captured } = await start({ consent: { required: true }, transport: { offline: { maxBytes: 8000 } } }, storage);
    for (let i = 0; i < 60; i++) {
      rum.recordEvent(`held.${i}`, { filler: "x".repeat(300) });
      await rum.flush();
    }
    rum.setConsent({ telemetry: true });
    await rum.flush();
    await sleep(50);
    // Evicted requests were never written, so there is nothing to remove for them on grant.
    expect(removed.filter((k) => k.startsWith("ouo.outbox.")).length).toBeLessThan(10);
    expect(captured.byName("held.59")).toHaveLength(1);
  });
});

describe("uninstall next to another SDK's patches", () => {
  it("shutdown does not remove an XHR patch installed after ouo's, and ouo's wrapper then only passes through", async () => {
    const sent: unknown[] = [];
    class FakeXhr {
      status = 200;
      open(): void {}
      setRequestHeader(): void {}
      send(body?: unknown): void {
        sent.push(body);
      }
      addEventListener(): void {}
    }
    const pristine = { open: FakeXhr.prototype.open, send: FakeXhr.prototype.send, setRequestHeader: FakeXhr.prototype.setRequestHeader };
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
    const { rum, captured } = await start();
    const ouoOpen = FakeXhr.prototype.open;
    const theirs = function (this: FakeXhr, ...a: unknown[]): void {
      return (ouoOpen as (...x: unknown[]) => void).apply(this, a);
    };
    FakeXhr.prototype.open = theirs as never;
    await rum.shutdown();
    expect(FakeXhr.prototype.open).toBe(theirs);
    // The methods nobody patched over are the originals again.
    expect(FakeXhr.prototype.send).toBe(pristine.send);
    expect(FakeXhr.prototype.setRequestHeader).toBe(pristine.setRequestHeader);
    const spans = captured.spans.length;
    const xhr = new FakeXhr();
    (xhr.open as (...a: unknown[]) => void)("GET", `${BACKEND}/x`);
    xhr.send("body");
    expect(sent).toEqual(["body"]);
    expect(captured.spans.length).toBe(spans);
    // A new init instruments again, on top of what is there.
    delete g.__ouoSessionProcessState;
    const again = initRUM(baseOptions()) as RUMInternal;
    await again.ready;
    expect(FakeXhr.prototype.send).not.toBe(pristine.send);
    await again._uninstall();
    FakeXhr.prototype.open = pristine.open;
  });

  it("the same for fetch, console.error and the global handler: left in place, as pass-throughs", async () => {
    const consoleCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => void consoleCalls.push(args);
    const { rum, captured } = await start();
    const ouoFetch = globalThis.fetch;
    const ouoConsole = console.error;
    const ouoHandler = g.ErrorUtils!.getGlobalHandler();
    const theirFetch = ((...a: Parameters<typeof fetch>) => ouoFetch(...a)) as typeof fetch;
    const theirConsole = (...a: unknown[]): void => ouoConsole(...a);
    const theirHandler = (e: unknown, f?: boolean): void => ouoHandler(e, f);
    globalThis.fetch = theirFetch;
    console.error = theirConsole;
    g.ErrorUtils!.setGlobalHandler(theirHandler);
    await rum.shutdown();
    expect(globalThis.fetch).toBe(theirFetch);
    expect(console.error).toBe(theirConsole);
    expect(g.ErrorUtils!.getGlobalHandler()).toBe(theirHandler);
    const before = captured.logs.length + captured.spans.length;
    const errors = guard.errors;
    await expect(fetch(`${BACKEND}/after`)).resolves.toBeInstanceOf(Response);
    console.error("after shutdown", new Error("x"));
    const fatal = new Error("after shutdown");
    g.ErrorUtils!.getGlobalHandler()(fatal, true);
    await sleep(20);
    // The chain still works end to end, and ouo records nothing.
    expect(consoleCalls.at(-1)![0]).toBe("after shutdown");
    expect(defaultHandlerCalls).toEqual([[fatal, true]]);
    expect(captured.logs.length + captured.spans.length).toBe(before);
    expect(guard.errors).toBe(errors);
  });
});

describe("beforeSend does not re-enter (ERR-5)", () => {
  it("a hook that records an event: that record skips the hook and is sent once", async () => {
    let calls = 0;
    let ref: RUMInternal | undefined;
    const { rum, captured } = await start({
      beforeSend: (r) => {
        calls++;
        ref?.recordEvent("from-hook");
        ref?.log.info("logged by the hook");
        return r.name === "dropped" ? null : r;
      },
    });
    ref = rum;
    calls = 0;
    rum.recordEvent("one");
    rum.recordEvent("dropped");
    rum.startSpan("a span").end();
    await rum.flush();
    // One hook call per record the app made; what the hook recorded was sent without one.
    expect({ calls, errors: guard.errors, sent: captured.byName("from-hook").length, logs: captured.byName("log").length }).toEqual({ calls: 3, errors: 0, sent: 3, logs: 3 });
    expect(captured.byName("one")).toHaveLength(1);
    expect(captured.byName("dropped")).toHaveLength(0);
    // The hook runs again for the next record: the flag does not stick, also after a throw.
    rum.recordEvent("two");
    expect(calls).toBe(4);
  });
});

describe("self-disable while init is running (ERR-6)", () => {
  it("leaves no hook installed and returns a no-op", async () => {
    const boom = (): never => {
      throw new Error("x");
    };
    g.expo = { modules: { OuoReplay: { takePendingCrash: boom, installCrashReporter: boom, getAppStartInfo: boom, start: boom } } };
    const captured = installFetchStub();
    const stub = globalThis.fetch;
    const handler = g.ErrorUtils!.getGlobalHandler();
    const consoleBefore = console.error;
    const rum = initRUM({ ...baseOptions(), replay: { enabled: true }, diagnostics: { selfDisableThreshold: 1 } }) as RUMInternal;
    await rum.ready;
    expect(guard.disabled).toBe(true);
    expect(globalThis.fetch).toBe(stub);
    expect(g.ErrorUtils!.getGlobalHandler()).toBe(handler);
    expect(console.error).toBe(consoleBefore);
    expect(getRUM()).toBeUndefined();
    expect(rum.getSessionId()).toBeUndefined();
    rum.recordEvent("nothing");
    await rum.flush();
    await sleep(20);
    expect(captured.logs).toHaveLength(0);
  });
});

describe("bypass cap (SMP-7)", () => {
  const record = (attributes: Record<string, unknown>): SdkLogRecord => ({ attributes, setAttribute: (k: string, v: unknown) => void (attributes[k] = v) }) as unknown as SdkLogRecord;
  const unhandled = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ "session.id": "s1", "event.name": "exception", "ouo.exception.handled": false, ...extra });

  it("JS errors marked fatal are capped; a native crash and a termination are not", () => {
    const sent: Array<Record<string, unknown>> = [];
    const inner = { onEmit: (r: SdkLogRecord) => void sent.push(r.attributes as Record<string, unknown>), forceFlush: async () => undefined, shutdown: async () => undefined };
    const p = new SampledLogProcessor(inner, () => false, undefined, 10);
    for (let i = 0; i < 100; i++) p.onEmit(record(unhandled({ "ouo.exception.fatal": true, "ouo.exception.kind": "uncaught" })));
    expect(sent).toHaveLength(10);
    p.onEmit(record(unhandled({ "ouo.exception.fatal": true, "ouo.exception.kind": "native" })));
    p.onEmit(record(unhandled({ "ouo.exception.fatal": true, "ouo.exception.kind": "termination" })));
    p.onEmit(record(unhandled({ "ouo.exception.fatal": false, "ouo.exception.kind": "hang" })));
    expect(sent).toHaveLength(12);
    expect(sent.every((a) => a["ouo.sampling.bypass"] === true)).toBe(true);
    // The cap is per session.
    p.onEmit(record(unhandled({ "session.id": "s2" })));
    expect(sent).toHaveLength(13);
  });
});

describe("what the SDK relies on outside its own code", () => {
  it("the OTel batch processors still have the private fields the queue-full count reads", () => {
    const exporter = { export: () => undefined, shutdown: async () => undefined, forceFlush: async () => undefined };
    const logs = new BatchLogRecordProcessor({ exporter: exporter as never }) as unknown as Record<string, unknown>;
    const spans = new BatchSpanProcessor(exporter as never) as unknown as Record<string, unknown>;
    // src/sampling.ts `queueFull`. If an upgrade renames these, queue-full drops stop being counted: fix it there.
    expect(Array.isArray(logs["_finishedLogRecords"])).toBe(true);
    expect(Array.isArray(spans["_finishedSpans"])).toBe(true);
    expect(typeof logs["_maxQueueSize"]).toBe("number");
    expect(typeof spans["_maxQueueSize"]).toBe("number");
    void (logs as { shutdown?: () => Promise<void> }).shutdown?.();
    void (spans as { shutdown?: () => Promise<void> }).shutdown?.();
  });

  it("every timer, frame and listener callback in src/ is wrapped by the guard, or on the allowlist", () => {
    // Call sites whose callback cannot fail or is not SDK logic. `file: text the line contains`.
    const ALLOWED: Array<[string, string]> = [
      ["session/storage.ts", "const t = setTimeout(() => {"], // withTimeout: sets a flag and resolves
      ["transport/send.ts", "abort.abort()"], // aborts the SDK's own request
      ["session/clock.ts", "globalThis.setTimeout(fn, ms)"], // systemClock: the unguarded base of guardedClock
      ["session/clock.ts", "setTimeout(fn: () => void, ms: number): TimerHandle;"], // the interface
      ["network.ts", 'this.addEventListener("abort"'], // sets a boolean
      ["vitals.ts", "const requestFrame ="], // wrapped where it is called: `raf`
      ["vitals.ts", "const startTimer ="], // wrapped where it is called: `setTimer`
      ["transport/outbox.ts", "this.clock.setTimeout("], // the clock `init` passes is guardedClock
      ["session/manager.ts", "this.clock.setTimeout("], // the clock `init` passes is guardedClock
    ];
    const root = join(__dirname, "..", "src");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const unguarded: string[] = [];
    let sites = 0;
    for (const file of files(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\b(setTimeout|setInterval|addEventListener|addListener|requestAnimationFrame)\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) return;
        sites++;
        const rel = file.slice(root.length + 1);
        // The callback is on this line or the next three (a multi-line call).
        const call = lines.slice(i, i + 4).join("\n");
        if (/guard\.wrap\(/.test(call) || NAMED_WRAPPED.some(([f, name]) => rel === f && call.includes(name))) return;
        if (ALLOWED.some(([f, text]) => rel === f && line.includes(text))) return;
        unguarded.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(sites).toBeGreaterThan(10);
    expect(unguarded).toEqual([]);
  });
});

/** Listeners registered by name whose definition is a `guard.wrap(...)` (or guards its own body) in the same file. */
const NAMED_WRAPPED: Array<[string, string]> = [
  ["network.ts", '"loadend", finish'],
  ["errors/install.ts", '"error", onError'],
  ["errors/install.ts", '"unhandledrejection", onRejection'],
];
