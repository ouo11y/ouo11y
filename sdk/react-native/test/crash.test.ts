import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatNativeStack, isReactNativeFatal, nativeCrashAttributes, parseNativeCrash, type NativeCrashReport } from "../src/crash";
import { initRUM, type RUMInternal } from "../src/index";
import { SESSION_STORAGE_KEY } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import { getRUM } from "../src/instance";

interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number };
}
interface OtlpLog {
  eventName?: string;
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

const g = globalThis as { __ouoSessionProcessState?: unknown };
let originalFetch: typeof fetch;

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


/** The Expo module as `globalThis.expo.modules.OuoReplay` exposes it, with the crash functions. */
function fakeCrashModule(pending: string | null) {
  let report = pending;
  const listeners = new Map<string, (payload: { report?: string }) => void>();
  return {
    listeners,
    /** The native side sends an event (Expo `sendEvent`). */
    send: (event: string, payload: { report?: string }) => listeners.get(event)?.(payload),
    addListener: vi.fn((event: string, fn: (payload: { report?: string }) => void) => {
      listeners.set(event, fn);
      return { remove: () => listeners.delete(event) };
    }),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isRecording: vi.fn(() => false),
    flush: vi.fn(() => Promise.resolve()),
    sessionDidRotate: vi.fn(),
    setSessionId: vi.fn(),
    installCrashReporter: vi.fn((_id: string, _startedAtMs: number) => true),
    setCrashSessionId: vi.fn((_id: string, _startedAtMs: number) => undefined),
    takePendingCrash: vi.fn(() => {
      const r = report;
      report = null;
      return r;
    }),
  };
}

const expoGlobal = globalThis as { expo?: { modules?: Record<string, unknown> } };

const CRASHED = "6a1f3c9e-1111-4aaa-8bbb-000000000001";
const crashAt = Date.now() - 60_000;

function signalReport(sessionId = CRASHED): NativeCrashReport {
  return {
    version: 1,
    mechanism: "signal",
    timestamp_ms: crashAt,
    session_id: sessionId,
    arch: "arm64",
    pid: 4242,
    thread: { main: true },
    signal: { number: 11, name: "SIGSEGV", mach_exception: "EXC_BAD_ACCESS", code: 1, code_name: "SEGV_MAPERR", address: "0x0" },
    frames: [
      { instruction_addr: "0x104a1c2f0", image_addr: "0x104a00000" },
      { instruction_addr: "0x1a2b3c4d8", image_addr: "0x1a2000000" },
      { instruction_addr: "0x7fff0000" },
    ],
    images: [
      { code_file: "/private/var/containers/Bundle/Application/X/sentrydemo.app/sentrydemo", debug_id: "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9", image_addr: "0x104a00000", image_size: 4194304, image_vmaddr: "0x100000000" },
      { code_file: "/System/Library/Frameworks/UIKitCore.framework/UIKitCore", debug_id: "11111111-2222-3333-4444-555555555555", image_addr: "0x1a2000000", image_size: 33554432, image_vmaddr: "0x18a000000" },
    ],
  } as NativeCrashReport;
}

describe("native crash report", () => {
  it("formats an Apple-style stack that atos can read line by line", () => {
    const stack = formatNativeStack(signalReport());
    const lines = stack.split("\n");
    expect(lines[0]).toBe("SIGSEGV: EXC_BAD_ACCESS (SIGSEGV) SEGV_MAPERR at 0x0");
    expect(lines[1]).toBe("Thread (main thread) crashed, arm64:");
    expect(lines[2]).toMatch(/^0   sentrydemo\s+0x0000000104a1c2f0 0x104a00000 \+ 115440$/);
    expect(lines[3]).toMatch(/^1   UIKitCore\s+0x00000001a2b3c4d8 0x1a2000000 \+ 11781336$/);
    expect(lines[4]).toMatch(/^2   \?\?\?\s+0x000000007fff0000$/);
    expect(stack).toContain("Binary Images:\n0x104a00000 - 0x104dfffff sentrydemo arm64 <0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9> /private/var/containers/Bundle/Application/X/sentrydemo.app/sentrydemo");
  });

  it("keeps instruction_addr, image_addr and the binary images verbatim for symbolication", () => {
    const attrs = nativeCrashAttributes(signalReport());
    expect(attrs["session.id"]).toBe(CRASHED);
    expect(attrs["ouo.exception.fatal"]).toBe(true);
    expect(attrs["ouo.exception.handled"]).toBe(false);
    expect(attrs["ouo.exception.kind"]).toBe("native");
    expect(attrs["exception.type"]).toBe("SIGSEGV");
    expect(JSON.parse(attrs["ouo.crash.frames"] as string)).toEqual(signalReport().frames);
    expect(JSON.parse(attrs["ouo.crash.images"] as string)).toEqual(signalReport().images);
    expect(attrs["ouo.crash.mach_exception"]).toBe("EXC_BAD_ACCESS");
  });

  it("parses what the native handler writes and rejects anything else", () => {
    expect(parseNativeCrash(JSON.stringify(signalReport()))?.session_id).toBe(CRASHED);
    expect(parseNativeCrash("{")).toBeUndefined();
    expect(parseNativeCrash(JSON.stringify({ ...signalReport(), session_started_ms: crashAt - 500 }))?.session_started_ms).toBe(crashAt - 500);
    expect(parseNativeCrash(JSON.stringify({ ...signalReport(), session_started_ms: "x" }))).not.toHaveProperty("session_started_ms");
    expect(parseNativeCrash(JSON.stringify({ mechanism: "other", timestamp_ms: 1 }))).toBeUndefined();
    const nsx = parseNativeCrash(JSON.stringify({ ...signalReport(), mechanism: "nsexception", signal: undefined, exception: { name: "NSInvalidArgumentException", reason: "bad" } }))!;
    expect(nativeCrashAttributes(nsx)["exception.type"]).toBe("NSInvalidArgumentException");
    expect(nativeCrashAttributes(nsx)["exception.message"]).toBe("bad");
    expect(isReactNativeFatal(nsx)).toBe(false);
    expect(isReactNativeFatal({ ...nsx, exception: { name: "RCTFatalException: boom", reason: "boom" } })).toBe(true);
  });

  it("hang and termination reports: kind, fatal, message, attributes", () => {
    const hang = parseNativeCrash(JSON.stringify({ ...signalReport(""), mechanism: "hang", signal: undefined, hang: { duration_ms: 2400, fully_blocking: false } }))!;
    expect(nativeCrashAttributes(hang)).toMatchObject({
      "exception.type": "AppHang",
      "exception.message": "App hanging for 2.4 s (not fully blocking)",
      "ouo.exception.kind": "hang",
      "ouo.exception.fatal": false,
      "ouo.hang.duration_ms": 2400,
      "ouo.hang.fully_blocking": false,
    });
    expect(nativeCrashAttributes(hang)).not.toHaveProperty("session.id");
    // A hang without its duration is not a hang report.
    expect(parseNativeCrash(JSON.stringify({ mechanism: "hang", timestamp_ms: 1 }))).toBeUndefined();
    const term = parseNativeCrash(JSON.stringify({ version: 1, mechanism: "termination", timestamp_ms: 5, session_id: "s", termination: { cause: "bogus" } }))!;
    expect(nativeCrashAttributes(term)).toEqual({
      "exception.type": "WatchdogTermination",
      "exception.message": "The app was terminated in the foreground without a crash report (cause: unknown)",
      "ouo.exception.fatal": true,
      "ouo.exception.handled": false,
      "ouo.exception.kind": "termination",
      "ouo.termination.cause": "unknown",
      "session.id": "s",
    });
    expect(isReactNativeFatal(term)).toBe(false);
  });

  it("a termination during a hang carries the hang's stack (review round 1)", () => {
    const r = parseNativeCrash(JSON.stringify({ ...signalReport("s"), mechanism: "termination", signal: undefined, termination: { cause: "watchdog" } }))!;
    const attrs = nativeCrashAttributes(r);
    expect(attrs["ouo.exception.kind"]).toBe("termination");
    expect(attrs["ouo.termination.cause"]).toBe("watchdog");
    expect(attrs["exception.stacktrace"]).toContain("Thread (main thread) hung");
    expect(attrs["ouo.crash.frames"]).toContain("instruction_addr");
    expect(attrs["ouo.exception.fatal"]).toBe(true);
  });
});

describe("initRUM with a native crash from the previous run", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete expoGlobal.expo;
    delete g.__ouoSessionProcessState;
  });

  function persistedSession(storage: MemoryAsyncStorage, id = CRASHED): Promise<void> {
    return storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ id, startedAt: crashAt - 120_000, lastActivity: crashAt - 30_000, userId: "anon-1", serviceVersion: "2.2.0" }));
  }

  it("ends the crashed session with reason crash at the crash time and emits its fatal native exception", async () => {
    const native = fakeCrashModule(JSON.stringify(signalReport()));
    expoGlobal.expo = { modules: { OuoReplay: native } };
    const captured = installFetchStub();
    const storage = new MemoryAsyncStorage();
    await persistedSession(storage);
    const rum = initRUM(makeOptions(storage)) as RUMInternal;
    expect(native.installCrashReporter).toHaveBeenCalledWith(rum.session.id(), expect.any(Number));
    // The session's start goes into a crash report (N52): the new session started just now.
    expect(Math.abs(native.installCrashReporter.mock.calls[0]![1] - Date.now())).toBeLessThan(5_000);
    await rum.ready;
    await rum.flush();
    const names = captured.logs.map((l) => attr(l.attributes, "event.name"));
    expect(names).toEqual(["session.end", "session.start", "exception"]);
    const [end, , exc] = captured.logs;
    expect(attr(end!.attributes, "session.id")).toBe(CRASHED);
    expect(attr(end!.attributes, "ouo.session.end_reason")).toBe("crash");
    expect(attr(end!.attributes, "ouo.session.ended_at")).toBe(crashAt);
    expect(attr(exc!.attributes, "session.id")).toBe(CRASHED);
    expect(attr(exc!.attributes, "ouo.exception.fatal")).toBe(true);
    expect(attr(exc!.attributes, "service.version")).toBe("2.2.0");
    expect(attr(exc!.attributes, "exception.stacktrace")).toContain("sentrydemo");
    expect(BigInt(exc!.timeUnixNano) / 1_000_000n).toBe(BigInt(crashAt));
    // The new session is the crash reporter's from now on.
    expect(native.takePendingCrash).toHaveBeenCalledTimes(1);
  });

  // N52: the process died in the session's first second, before its record reached storage. The
  // crash report alone names the session and its start; it still ends, from that start.
  it("a crash before the session was persisted still ends that session from its start", async () => {
    const native = fakeCrashModule(JSON.stringify({ ...signalReport(), session_started_ms: crashAt - 400 }));
    expoGlobal.expo = { modules: { OuoReplay: native } };
    const captured = installFetchStub();
    const storage = new MemoryAsyncStorage();
    await persistedSession(storage, "older");
    const rum = initRUM(makeOptions(storage)) as RUMInternal;
    await rum.ready;
    await rum.flush();
    const ends = captured.logs.filter((l) => attr(l.attributes, "event.name") === "session.end");
    const lost = ends.find((l) => attr(l.attributes, "session.id") === CRASHED);
    expect(lost).toBeDefined();
    expect(attr(lost!.attributes, "ouo.session.end_reason")).toBe("crash");
    expect(attr(lost!.attributes, "ouo.session.started_at")).toBe(crashAt - 400);
    expect(attr(lost!.attributes, "ouo.session.ended_at")).toBe(crashAt);
    // The older session is not the one that crashed.
    const older = ends.find((l) => attr(l.attributes, "session.id") === "older");
    expect(attr(older!.attributes, "ouo.session.end_reason")).not.toBe("crash");
    const start = captured.logs.find((l) => attr(l.attributes, "event.name") === "session.start");
    expect(attr(start!.attributes, "session.previous_id")).toBe(CRASHED);
    const exc = captured.logs.find((l) => attr(l.attributes, "event.name") === "exception");
    expect(attr(exc!.attributes, "session.id")).toBe(CRASHED);
  });

  it("a React Native fatal (RCTFatalException) only supplies the end time: the JS handler already reported it", async () => {
    const report = { ...signalReport(), mechanism: "nsexception", signal: undefined, exception: { name: "RCTFatalException: boom", reason: "boom" } };
    expoGlobal.expo = { modules: { OuoReplay: fakeCrashModule(JSON.stringify(report)) } };
    const captured = installFetchStub();
    const storage = new MemoryAsyncStorage();
    await persistedSession(storage);
    const rum = initRUM(makeOptions(storage)) as RUMInternal;
    await rum.ready;
    await rum.flush();
    expect(captured.logs.map((l) => attr(l.attributes, "event.name"))).toEqual(["session.end", "session.start"]);
    expect(attr(captured.logs[0]!.attributes, "ouo.session.end_reason")).toBe("crash");
    expect(attr(captured.logs[0]!.attributes, "ouo.session.ended_at")).toBe(crashAt);
  });

  it("rotations reach the native crash reporter; errors.nativeCrashes: false installs nothing", async () => {
    const native = fakeCrashModule(null);
    expoGlobal.expo = { modules: { OuoReplay: native } };
    installFetchStub();
    const storage = new MemoryAsyncStorage();
    await persistedSession(storage, "other");
    const rum = initRUM(makeOptions(storage)) as RUMInternal;
    await rum.ready;
    expect(native.setCrashSessionId).toHaveBeenCalledWith(rum.session.id(), expect.any(Number));
    await rum._uninstall();

    delete g.__ouoSessionProcessState;
    const off = fakeCrashModule(JSON.stringify(signalReport()));
    expoGlobal.expo = { modules: { OuoReplay: off } };
    const rum2 = initRUM({ ...makeOptions(new MemoryAsyncStorage()), errors: { nativeCrashes: false } }) as RUMInternal;
    await rum2.ready;
    expect(off.installCrashReporter).not.toHaveBeenCalled();
    expect(off.takePendingCrash).not.toHaveBeenCalled();
  });

  it("a foreground termination (no crash report) is a fatal termination exception; the session is crashed at the last alive time", async () => {
    const report = { version: 1, mechanism: "termination", timestamp_ms: crashAt, session_id: CRASHED, termination: { cause: "memory" } };
    expoGlobal.expo = { modules: { OuoReplay: fakeCrashModule(JSON.stringify(report)) } };
    const captured = installFetchStub();
    const storage = new MemoryAsyncStorage();
    await persistedSession(storage);
    const rum = initRUM(makeOptions(storage)) as RUMInternal;
    await rum.ready;
    await rum.flush();
    expect(captured.logs.map((l) => attr(l.attributes, "event.name"))).toEqual(["session.end", "session.start", "exception"]);
    const [end, , exc] = captured.logs;
    expect(attr(end!.attributes, "ouo.session.end_reason")).toBe("crash");
    expect(attr(end!.attributes, "ouo.session.ended_at")).toBe(crashAt);
    expect(attr(exc!.attributes, "session.id")).toBe(CRASHED);
    expect(attr(exc!.attributes, "ouo.exception.kind")).toBe("termination");
    expect(attr(exc!.attributes, "exception.type")).toBe("WatchdogTermination");
    expect(attr(exc!.attributes, "ouo.termination.cause")).toBe("memory");
    expect(attr(exc!.attributes, "ouo.exception.fatal")).toBe(true);
    expect(attr(exc!.attributes, "exception.stacktrace")).toBeUndefined();
    expect(attr(exc!.attributes, "ouo.crash.frames")).toBeUndefined();
    expect(BigInt(exc!.timeUnixNano) / 1_000_000n).toBe(BigInt(crashAt));
  });

  it("a hang reported by the native watchdog is one non-fatal hang exception on the current session, stamped at its start", async () => {
    const native = fakeCrashModule(null);
    expoGlobal.expo = { modules: { OuoReplay: native } };
    const captured = installFetchStub();
    const rum = initRUM(makeOptions(new MemoryAsyncStorage())) as RUMInternal;
    // Listening before the native side starts its watchdog.
    expect(native.addListener.mock.invocationCallOrder[0]!).toBeLessThan(native.installCrashReporter.mock.invocationCallOrder[0]!);
    await rum.ready;
    const startedAt = Date.now() - 3500;
    const hang = { ...signalReport(""), mechanism: "hang", signal: undefined, timestamp_ms: startedAt, hang: { duration_ms: 3012.5, fully_blocking: true } };
    native.send("onHang", { report: JSON.stringify(hang) });
    native.send("onHang", { report: "{" }); // unreadable: dropped
    await rum.flush();
    const hangs = captured.logs.filter((l) => attr(l.attributes, "event.name") === "exception");
    expect(hangs).toHaveLength(1);
    const a = hangs[0]!.attributes;
    expect(attr(a, "session.id")).toBe(rum.session.id());
    expect(attr(a, "ouo.exception.kind")).toBe("hang");
    expect(attr(a, "exception.type")).toBe("AppHang");
    expect(attr(a, "exception.message")).toBe("App hanging for 3.0 s");
    expect(attr(a, "ouo.exception.fatal")).toBe(false);
    expect(attr(a, "ouo.exception.handled")).toBe(false);
    expect(attr(a, "ouo.hang.duration_ms")).toBe(3012.5);
    expect(attr(a, "ouo.hang.fully_blocking")).toBe(true);
    expect(attr(a, "exception.stacktrace")).toContain("Thread (main thread) hung");
    expect(attr(a, "ouo.crash.frames")).toContain("instruction_addr"); // symbolication reads it like a crash
    expect(BigInt(hangs[0]!.timeUnixNano) / 1_000_000n).toBe(BigInt(startedAt));
    await rum._uninstall();
    expect(native.listeners.size).toBe(0);
  });
});
describe("error context (docs/specs/mobile-sdk.md C2)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete expoGlobal.expo;
    delete g.__ouoSessionProcessState;
  });

  const lastEvents = (l: OtlpLog): Array<{ name: string; body: string }> => JSON.parse(String(attr(l.attributes, "ouo.last_events") ?? "[]"));

  it("every exception of the run carries the last events, the screen, the locale, memory and network", async () => {
    const native = { ...fakeCrashModule(null), getErrorContext: vi.fn(() => ({ memoryFootprintBytes: 123_000_000, memoryAvailableBytes: 900_000_000, networkType: "wifi" })) };
    expoGlobal.expo = { modules: { OuoReplay: native } };
    const captured = installFetchStub();
    const rum = initRUM(makeOptions(new MemoryAsyncStorage())) as RUMInternal;
    await rum.ready;
    rum.trackNavigation("/Home");
    rum.trackNavigation("/Cart");
    rum.addEvent("coupon_applied");
    rum.captureError(new Error("payment declined"));
    native.send("onHang", { report: JSON.stringify({ ...signalReport(""), mechanism: "hang", signal: undefined, timestamp_ms: Date.now(), hang: { duration_ms: 2500, fully_blocking: true } }) });
    await rum.flush();
    const [handled, hang] = captured.logs.filter((l) => attr(l.attributes, "event.name") === "exception");
    for (const e of [handled!, hang!]) {
      expect(attr(e.attributes, "app.screen.name")).toBe("Cart");
      expect(attr(e.attributes, "ouo.device.locale")).toBe(Intl.DateTimeFormat().resolvedOptions().locale);
      expect(attr(e.attributes, "ouo.memory.app_bytes")).toBe(123_000_000);
      expect(attr(e.attributes, "ouo.memory.available_bytes")).toBe(900_000_000);
      expect(attr(e.attributes, "network.connection.type")).toBe("wifi");
    }
    // The session's timeline before the error, oldest first, the error itself not included.
    expect(lastEvents(handled!).map((e) => e.name)).toEqual(["session.start", "navigation", "navigation", "coupon_applied"]);
    expect(lastEvents(handled!)[2]!.body).toBe("/Cart");
    expect(lastEvents(hang!).at(-1)!.body).toBe("Error: payment declined");
  });

  it("at most the last 20 events", async () => {
    expoGlobal.expo = { modules: { OuoReplay: fakeCrashModule(null) } };
    const captured = installFetchStub();
    const rum = initRUM(makeOptions(new MemoryAsyncStorage())) as RUMInternal;
    await rum.ready;
    for (let i = 0; i < 30; i++) rum.addEvent(`step_${i}`);
    rum.captureError(new Error("late"));
    await rum.flush();
    const e = captured.logs.find((l) => attr(l.attributes, "event.name") === "exception")!;
    const names = lastEvents(e).map((x) => x.name);
    expect(names).toHaveLength(20);
    expect(names.at(-1)).toBe("step_29");
  });

  it("a native crash reported by the next launch carries the crashed run's screen and last events", async () => {
    const storage = new MemoryAsyncStorage();
    // Run 1: navigates, then dies (the context is persisted on background and within a second).
    expoGlobal.expo = { modules: { OuoReplay: fakeCrashModule(null) } };
    installFetchStub();
    const run1 = initRUM(makeOptions(storage)) as RUMInternal;
    await run1.ready;
    run1.trackNavigation("/Checkout");
    run1.addEvent("pay_tapped");
    await run1.flush(); // persists the context now
    const crashedId = run1.session.id();
    await run1._uninstall();
    delete g.__ouoSessionProcessState;

    // Run 2: the native report names run 1's session.
    expoGlobal.expo = { modules: { OuoReplay: fakeCrashModule(JSON.stringify(signalReport(crashedId))) } };
    const captured = installFetchStub();
    const run2 = initRUM(makeOptions(storage)) as RUMInternal;
    await run2.ready;
    await run2.flush();
    const exc = captured.logs.find((l) => attr(l.attributes, "event.name") === "exception")!;
    expect(attr(exc.attributes, "session.id")).toBe(crashedId);
    expect(attr(exc.attributes, "app.screen.name")).toBe("Checkout");
    expect(lastEvents(exc).map((e) => e.name)).toEqual(["session.start", "navigation", "pay_tapped"]);
    // Memory and network were not measured at the crash: absent, not this run's values.
    expect(attr(exc.attributes, "ouo.memory.app_bytes")).toBeUndefined();
    expect(attr(exc.attributes, "network.connection.type")).toBeUndefined();
  });
});

describe("Android reports (sdk/android Signals)", () => {
  const jvm = {
    version: 1,
    platform: "android",
    mechanism: "jvm",
    timestamp_ms: 1_760_000_000_000,
    session_id: "s-android",
    session_started_ms: 1_759_999_990_000,
    exception: { name: "java.lang.IllegalStateException", reason: "ouo-mobile: native crash\nCaused by: java.io.IOException: disk" },
    thread: { main: true },
    frames: [
      { module: "dev.ouo.chaos.OuoChaosModule", function: "crash", filename: "OuoChaosModule.kt", lineno: 61 },
      { module: "android.os.Handler", function: "handleCallback" },
    ],
    images: [],
  };

  it("parses a jvm crash and keeps its JVM frames", () => {
    const r = parseNativeCrash(JSON.stringify(jvm))!;
    expect(r.mechanism).toBe("jvm");
    expect(r.frames).toHaveLength(2);
    const a = nativeCrashAttributes(r);
    expect(a["ouo.exception.kind"]).toBe("native");
    expect(a["ouo.exception.fatal"]).toBe(true);
    expect(a["exception.type"]).toBe("java.lang.IllegalStateException");
    expect(a["exception.message"]).toContain("Caused by: java.io.IOException: disk");
    expect(a["ouo.crash.thread_main"]).toBe(true);
    expect(formatNativeStack(r)).toBe(
      [
        "java.lang.IllegalStateException: ouo-mobile: native crash\nCaused by: java.io.IOException: disk",
        "Thread (main thread) crashed:",
        "    at dev.ouo.chaos.OuoChaosModule.crash(OuoChaosModule.kt:61)",
        "    at android.os.Handler.handleCallback(Unknown Source)",
      ].join("\n"),
    );
    expect(isReactNativeFatal(r)).toBe(false);
  });

  it("treats React Native's JavascriptException as the JS fatal it wraps", () => {
    const r = parseNativeCrash(JSON.stringify({ ...jvm, exception: { name: "com.facebook.react.common.JavascriptException", reason: "Error: boom" } }))!;
    expect(isReactNativeFatal(r)).toBe(true);
  });

  it("reads Android hangs and terminations", () => {
    const hang = parseNativeCrash(JSON.stringify({ ...jvm, mechanism: "hang", exception: undefined, hang: { duration_ms: 3050, fully_blocking: true } }))!;
    const h = nativeCrashAttributes(hang);
    expect([h["ouo.exception.kind"], h["ouo.exception.fatal"], h["ouo.hang.duration_ms"], h["exception.type"]]).toEqual(["hang", false, 3050, "AppHang"]);
    expect(String(h["exception.stacktrace"])).toContain("Thread (main thread) hung:");
    const term = parseNativeCrash(JSON.stringify({ ...jvm, mechanism: "termination", exception: undefined, thread: undefined, frames: [], termination: { cause: "memory" } }))!;
    const t = nativeCrashAttributes(term);
    expect([t["ouo.exception.kind"], t["ouo.exception.fatal"], t["ouo.termination.cause"], t["exception.stacktrace"]]).toEqual(["termination", true, "memory", undefined]);
  });
});
