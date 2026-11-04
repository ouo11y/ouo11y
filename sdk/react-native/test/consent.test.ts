/**
 * Consent (README, "Consent"; docs/specs/session-lifecycle.md, "No session before consent"):
 * while pending the SDK touches neither `storage` nor the native module nor the network and has
 * no session; the grant runs the queued calls; a revocation stops export and deletes what the SDK
 * stored; replay consent drives the native recorder alone; the default is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_QUEUE_LIMIT, initRUM, type RUM, type RUMInternal, type RUMOptions } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";
import type { GlobalErrorHandler } from "../src/errors/install";

type OtlpAttr = { key: string; value: { stringValue?: string; intValue?: string | number; boolValue?: boolean } };
type Log = { eventName?: string; attributes: OtlpAttr[] };

const ENDPOINT = "http://otel.test:4318";
const attr = (r: Log, key: string): unknown => {
  const v = r.attributes.find((a) => a.key === key)?.value;
  return v?.stringValue ?? (v?.intValue !== undefined ? Number(v.intValue) : v?.boolValue);
};

/** The Expo module, every function a spy: nothing of it may run before consent. */
function fakeNative() {
  const posts: Array<{ url: string; body: string }> = [];
  let recording = false;
  const native = {
    start: vi.fn(() => {
      recording = true;
    }),
    pause: vi.fn(() => {
      recording = false;
    }),
    resume: vi.fn(() => {
      recording = true;
    }),
    stop: vi.fn(() => {
      recording = false;
    }),
    isRecording: vi.fn(() => recording),
    flush: vi.fn(() => Promise.resolve()),
    sessionDidRotate: vi.fn(),
    setSessionId: vi.fn(),
    screenDidChange: vi.fn(),
    recoverPendingChunk: vi.fn(),
    heldReplaySessions: vi.fn(() => Promise.resolve([{ sessionId: "held-1", chunks: 2, bytes: 100, firstAt: 1, lastAt: 2 }])),
    releaseHeldReplay: vi.fn(),
    postOtlp: vi.fn((url: string, _headers: Record<string, string>, body: string) => {
      posts.push({ url, body });
      return Promise.resolve({ status: 200 });
    }),
    installCrashReporter: vi.fn(() => true),
    setCrashSessionId: vi.fn(),
    takePendingCrash: vi.fn(() => null),
    getErrorContext: vi.fn(() => ({})),
    getAppStartInfo: vi.fn(() => undefined),
    getFrameStats: vi.fn(() => undefined),
    addListener: vi.fn(() => ({ remove: () => undefined })),
  };
  const logs = (): Log[] =>
    posts
      .filter((p) => p.url.endsWith("/v1/logs"))
      .flatMap((p) => (JSON.parse(p.body) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Log[] }> }> }).resourceLogs)
      .flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords));
  const calls = (): string[] => Object.entries(native).filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);
  return { native, posts, logs, calls };
}

/** MemoryAsyncStorage that records every operation. */
function spiedStorage() {
  const storage = new MemoryAsyncStorage();
  const ops: string[] = [];
  const get = storage.getItem.bind(storage);
  const set = storage.setItem.bind(storage);
  const remove = storage.removeItem.bind(storage);
  storage.getItem = (k) => (ops.push(`get ${k}`), get(k));
  storage.setItem = (k, v) => (ops.push(`set ${k}`), set(k, v));
  storage.removeItem = (k) => (ops.push(`remove ${k}`), remove(k));
  const keys = (): string[] => [...(storage as unknown as { map: Map<string, string> }).map.keys()].sort();
  return { storage, ops, keys };
}

const g = globalThis as { expo?: { modules?: Record<string, unknown> }; ErrorUtils?: unknown; __ouoSessionProcessState?: unknown };
let fake: ReturnType<typeof fakeNative>;
let store: ReturnType<typeof spiedStorage>;
let handler: GlobalErrorHandler;
const originalFetch = globalThis.fetch;
const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}")));

const options = (extra: Partial<RUMOptions> = {}): RUMOptions => ({
  endpoint: ENDPOINT,
  projectId: "demo",
  projectToken: "pt_test_consent",
  service: { name: "mobile-store", version: "1.0.0", environment: "test" },
  storage: store.storage,
  ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  fake = fakeNative();
  store = spiedStorage();
  g.expo = { modules: { OuoReplay: fake.native } };
  handler = () => undefined;
  g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h: GlobalErrorHandler) => (handler = h) };
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  globalThis.fetch = originalFetch;
  delete g.expo;
  delete g.ErrorUtils;
  delete g.__ouoSessionProcessState;
});

describe("consent pending", () => {
  it("touches no storage, no native function, no network, patches nothing and has no session", async () => {
    const before = handler;
    const rum = initRUM(options({ consent: "pending", replay: { enabled: true } }));
    rum.setUser({ id: "u-1" });
    rum.addEvent("cart.add");
    rum.captureError(new Error("before consent"));
    rum.log.info("hello");
    rum.trackNavigation("/Home");
    rum.trackTap("buy");
    rum.recordActivity();
    rum.replay.resume();
    rum.withSpan("work", (span) => span.setAttribute("a", 1));
    expect(rum.feedback({ message: "hi" })).toBeUndefined();
    await rum.flush();
    await sleep(1200);

    expect(rum.getConsent()).toEqual({ status: "pending", telemetry: false, replay: false });
    expect(rum.session.id()).toBe("");
    expect(store.ops).toEqual([]);
    expect(fake.calls()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(fetchSpy); // not instrumented
    expect(handler).toBe(before); // no global error handler installed
    expect(g.__ouoSessionProcessState).toBeUndefined();
  });

  it("the grant starts the session and runs the queued calls; of the screen views only the last", async () => {
    const rum = initRUM(options({ consent: "pending" }));
    let ready = false;
    void rum.ready.then(() => (ready = true));
    rum.trackNavigation("/Home");
    rum.addEvent("before.user");
    rum.setUser({ id: "u-1" });
    rum.trackNavigation("/Cart");
    rum.captureError(new Error("before consent"));
    rum.log.warn("queued log");
    await sleep(20);
    expect(ready).toBe(false);

    await rum.setConsent({ telemetry: true, replay: false });
    await rum.ready;
    expect(rum.getConsent()).toEqual({ status: "granted", telemetry: true, replay: false });
    expect(rum.session.id()).not.toBe("");
    expect(store.keys()).toContain("ouo.session");
    await rum.flush();

    const logs = fake.logs();
    const names = logs.map((r) => r.eventName);
    expect(names.filter((n) => n === "navigation")).toHaveLength(1);
    expect(attr(logs.find((r) => r.eventName === "navigation")!, "url.path")).toBe("/Cart");
    expect(names).toEqual(expect.arrayContaining(["session.start", "before.user", "exception"]));
    expect(attr(logs.find((r) => r.eventName === "exception")!, "user.id")).toBe("u-1");
    expect(attr(logs.find((r) => r.eventName === "before.user")!, "user.id")).not.toBe("u-1");
    expect(logs.every((r) => attr(r, "session.id") === rum.session.id())).toBe(true);
  });

  it("keeps at most CONSENT_QUEUE_LIMIT calls, dropping the oldest", async () => {
    const rum = initRUM(options({ consent: "pending" }));
    for (let i = 0; i < CONSENT_QUEUE_LIMIT + 20; i++) rum.addEvent("queued", { i });
    await rum.setConsent({ telemetry: true, replay: false });
    await rum.flush();
    const queued = fake.logs().filter((r) => r.eventName === "queued");
    expect(queued).toHaveLength(CONSENT_QUEUE_LIMIT);
    expect(attr(queued[0]!, "i")).toBe(20);
  });

  it("refused at launch: drops the queue and deletes what an earlier launch stored", async () => {
    await store.storage.setItem("ouo.session", "{}");
    await store.storage.setItem("ouo.outbox", JSON.stringify({ next: 3, items: [{ id: 2, url: `${ENDPOINT}/v1/logs`, bytes: 2 }] }));
    await store.storage.setItem("ouo.outbox.2", "{}");
    await store.storage.setItem("app.theme", "dark");
    const rum = initRUM(options({ consent: "pending" }));
    rum.addEvent("queued");
    await rum.setConsent({ telemetry: false, replay: true });
    expect(rum.getConsent()).toEqual({ status: "denied", telemetry: false, replay: false });
    expect(store.keys()).toEqual(["app.theme"]);
    expect(fake.posts).toEqual([]);
  });
});

describe("consent revoked", () => {
  it("stops export, deletes the stored session, requests and held replay; a new grant is a new session", async () => {
    const rum: RUM = initRUM(options({ replay: { enabled: true, keepAtNextLaunch: () => true } }));
    await rum.ready;
    const first = rum.session.id();
    rum.setUser({ id: "u-1" });
    rum.addEvent("sent");
    await rum.flush();
    expect(fake.posts.length).toBeGreaterThan(0);
    expect(fake.native.start).toHaveBeenCalled();

    const sent = fake.posts.length;
    rum.addEvent("batched.at.revoke");
    await rum.setConsent({ telemetry: false, replay: false });

    expect(rum.getConsent().status).toBe("denied");
    expect(rum.session.id()).toBe("");
    expect(fake.posts.length).toBe(sent);
    expect(fake.native.stop).toHaveBeenCalled();
    expect(fake.native.releaseHeldReplay).toHaveBeenCalledWith(expect.any(String), expect.anything(), "held-1", false);
    expect(store.keys()).toEqual([]);
    expect(g.__ouoSessionProcessState).toBeUndefined();

    rum.addEvent("after.revoke");
    await rum.flush();
    await sleep(1200);
    expect(fake.posts.length).toBe(sent);
    expect(store.keys()).toEqual([]);

    await rum.setConsent({ telemetry: true, replay: false });
    await rum.flush();
    expect(rum.session.id()).not.toBe("");
    expect(rum.session.id()).not.toBe(first);
    expect(rum.session.userId()).not.toBe("u-1");
    expect(fake.logs().map((r) => r.eventName)).not.toContain("batched.at.revoke");
  });
});

describe("replay consent", () => {
  const replay = { enabled: true, sampleRate: 1 };

  it("telemetry without replay never starts the native recorder; replay granted later starts it", async () => {
    const rum = initRUM(options({ consent: "pending", replay }));
    rum.replay.hideScreen();
    await rum.setConsent({ telemetry: true, replay: false });
    await rum.ready;
    rum.replay.resume();
    rum.replay.showScreen();
    await sleep(600); // past SHOW_DELAY_MS
    expect(fake.native.start).not.toHaveBeenCalled();
    expect(rum.replay.isRecording()).toBe(false);

    await rum.setConsent({ telemetry: true, replay: true });
    expect(fake.native.start).toHaveBeenCalledTimes(1);
    expect(rum.replay.isRecording()).toBe(true);

    await rum.setConsent({ telemetry: true, replay: false });
    expect(fake.native.pause).toHaveBeenCalled();
    expect(rum.replay.isRecording()).toBe(false);
    rum.replay.resume(); // the app's resume does not override consent
    expect(rum.replay.isRecording()).toBe(false);
  });

  it("a screen hidden before the grant stays hidden from the first frame", async () => {
    const rum = initRUM(options({ consent: "pending", replay }));
    rum.replay.hideScreen();
    await rum.setConsent({ telemetry: true, replay: true });
    expect(fake.native.start).not.toHaveBeenCalled();
    rum.replay.showScreen();
    await sleep(600);
    expect(fake.native.start).toHaveBeenCalledTimes(1);
  });
});

describe("default: consent granted", () => {
  it("an app that never mentions consent starts at once, replay included", async () => {
    const rum = initRUM(options({ replay: { enabled: true } }));
    expect(rum.getConsent()).toEqual({ status: "granted", telemetry: true, replay: true });
    expect(rum.session.id()).not.toBe("");
    expect(fake.native.start).toHaveBeenCalledTimes(1);
    expect(fake.native.installCrashReporter).toHaveBeenCalled();
    await rum.ready;
    expect(store.ops.length).toBeGreaterThan(0);
  });
});
