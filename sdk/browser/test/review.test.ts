/**
 * Regression tests from the review of PR #182. Each one failed before its fix: a reused fetch
 * init, an outage longer than the drain grace, a user cleared in another tab, `shutdown()` then
 * `init()` without awaiting, and records held while consent is denied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/core/clock";
import { DropCounter } from "../src/core/drops";
import * as ouo from "../src/index";
import { silentLogger } from "../src/logger";
import { SESSION_KEY, SessionManager } from "../src/session/manager";
import { MemoryStorage } from "../src/session/storage";
import { Http } from "../src/transport/http";
import { OutboxDrainer, TelemetryQueue } from "../src/transport/queue";
import { MemoryOutbox } from "../src/transport/store";
import { FakeCollector, wait } from "./helpers/collector";

const BASE = "http://collector.test:4318";
const collector = new FakeCollector(BASE);

beforeEach(() => {
  localStorage.clear();
  collector.reset();
  collector.install();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});
afterEach(async () => {
  await ouo.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("B. an init object or Headers the app reuses", () => {
  it("each request gets its own traceparent", async () => {
    ouo.init({ endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 100, persist: { enabled: false } } });
    const init: RequestInit = { headers: { "x-app": "1" } };
    await fetch("http://localhost:3000/api/a", init);
    await fetch("http://localhost:3000/api/b", init);
    const [a, b] = collector.app;
    expect(a!.headers["traceparent"]).toBeDefined();
    expect(b!.headers["traceparent"]).toBeDefined();
    expect(b!.headers["traceparent"]).not.toBe(a!.headers["traceparent"]);
  });
  it("a reused init does not carry the SDK's trace header to an origin outside the allow-list", async () => {
    ouo.init({ endpoint: BASE, serviceName: "web-store", propagation: { sessionBaggage: true }, transport: { flushIntervalMs: 100, persist: { enabled: false } } });
    const init: RequestInit = { headers: { "x-app": "1" } };
    await fetch("http://localhost:3000/api/a", init);
    await fetch("https://third-party.example/api", init);
    const third = collector.app[1]!;
    expect(third.headers["traceparent"]).toBeUndefined();
    expect(third.headers["baggage"]).toBeUndefined();
  });
});

class FakeClock implements Clock {
  t = 1_700_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.set(this.next, { at: this.t + ms, fn });
    return this.next++;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    this.t = end;
  }
}

describe("C. an outage longer than the drain grace", () => {
  it("a batch is delivered once", async () => {
    const clock = new FakeClock();
    const outbox = new MemoryOutbox(1024 * 1024);
    let up = false;
    const delivered: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (!up) return new Response("", { status: 503 });
      delivered.push(new TextDecoder().decode(init.body as Uint8Array));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const http = new Http({ headers: {}, timeoutMs: 5000, clock, fetchImpl });
    const drops = new DropCounter();
    const settings = { flushIntervalMs: 1000, maxBatchRecords: 10, maxRequestBytes: 1 << 20, maxQueueRecords: 100, retryInitialMs: 1000, retryMaxMs: 30_000 };
    const drainer = new OutboxDrainer({
      outbox: () => outbox, http, urls: { logs: "http://c/v1/logs", traces: "http://c/v1/traces" }, rejected: { logs: () => 0, traces: () => 0 }, drops,
      ttlMs: 72 * 3_600_000, retryInitialMs: 1000, retryMaxMs: 30_000, gate: () => "open", hidden: () => false, clock,
    });
    const queue = new TelemetryQueue<string>({
      signal: "logs", url: "http://c/v1/logs", serialize: (items) => new TextEncoder().encode(items.join(",")), rejected: () => 0, isBypass: () => false, nameOf: () => "e",
      http, outbox: () => outbox, onStored: (id) => drainer.own(id), drops, settings, logger: silentLogger, gate: () => "open", hidden: () => false, clock, random: () => 1,
    });
    drainer.schedule(1000);
    queue.add("record-1");
    await clock.advance(40_000); // collector down for 40 s
    up = true;
    drainer.schedule(0); // what the `online` and `visibilitychange` handlers of index.ts do
    await clock.advance(120_000);
    queue.close();
    drainer.close();
    expect(delivered).toEqual(["record-1"]);
  });
});

describe("D. setUser(null) with a second tab open", () => {
  it("the cleared user does not come back", () => {
    const storage = new MemoryStorage();
    const mk = () =>
      new SessionManager({
        storage, locks: null, inactivityTimeoutMs: 1_800_000, maxDurationMs: 14_400_000, sessionRate: 1,
        hooks: { onStart: () => undefined, onEnd: () => undefined, onChange: () => undefined, hold: () => undefined, release: () => undefined, restamp: () => undefined },
      });
    const a = mk();
    const b = mk();
    a.start(true);
    b.start(true);
    a.setUser("alice");
    b.handleStorage(storage.get(SESSION_KEY));
    expect(b.stamp().user).toBe("alice");
    a.setUser(null); // logout in tab A
    b.handleStorage(storage.get(SESSION_KEY));
    expect(b.stamp().user).toBeUndefined();
    b.persist();
    a.handleStorage(storage.get(SESSION_KEY));
    expect(a.stamp().user).toBeUndefined();
  });
});

describe("E. shutdown() then init() without awaiting", () => {
  it("the new instance still turns itself off at the threshold", async () => {
    const cfg: ouo.OuoConfig = { endpoint: BASE, serviceName: "web-store", diagnostics: { selfDisableThreshold: 3 }, transport: { flushIntervalMs: 100, persist: { enabled: false } } };
    ouo.init(cfg);
    void ouo.shutdown();
    ouo.init(cfg);
    await wait(300);
    expect(ouo.diagnostics().state).toBe("running");
    ouo._internal.injectFault("emit");
    for (let i = 0; i < 6; i++) ouo.recordEvent("x");
    ouo._internal.injectFault("emit", false);
    expect(ouo.diagnostics().internalErrors).toBeGreaterThanOrEqual(3);
    expect(ouo.diagnostics().state).toBe("disabled");
  });
});

/** jsdom has no Web Locks: give the page's navigator a lock manager for one test. */
function useLocks(locks: unknown): void {
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
}

describe("F. consent denied while a session start is being confirmed under the Web Lock", () => {
  afterEach(() => {
    delete (navigator as unknown as { locks?: unknown }).locks;
  });

  it("records held for the start are not sent, and nothing leaves after the denial", async () => {
    // A lock manager that grants asynchronously, like a browser's.
    const locks = { request: (_n: string, _o: unknown, cb: () => unknown) => new Promise((r) => setTimeout(() => r(cb()), 30)), query: async () => ({ held: [] }) };
    useLocks(locks);
    ouo.init({ endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 50, persist: { enabled: false } } });
    expect(ouo.diagnostics().state).toBe("running");
    ouo.recordEvent("held.event");
    ouo.setConsent({ telemetry: false });
    await wait(300);
    await collector.settled();
    expect(collector.logs.map((l) => l.eventName)).not.toContain("held.event");
    const before = collector.requests.length;
    ouo.recordEvent("after.denial");
    await wait(200);
    expect(collector.requests.length).toBe(before);
  });

  it("with an asynchronous lock, shutdown still ends the session and consent withdrawal still says why", async () => {
    const locks = { request: (_n: string, _o: unknown, cb: () => unknown) => new Promise((r) => setTimeout(() => r(cb()), 10)), query: async () => ({ held: [{ name: "ouo.tab" }] }) };
    useLocks(locks);
    const cfg: ouo.OuoConfig = { endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 50, persist: { enabled: false } } };
    ouo.init(cfg);
    await ouo.flush();
    await ouo.shutdown();
    await collector.settled();
    expect(collector.events("session.end").map((e) => e.attributes["ouo.session.end_reason"])).toEqual(["shutdown"]);
    collector.reset();
    collector.install();
    localStorage.clear();
    ouo.init(cfg);
    await ouo.flush();
    ouo.setConsent({ telemetry: false });
    await wait(200);
    await collector.settled();
    expect(collector.events("session.end").map((e) => e.attributes["ouo.session.end_reason"])).toEqual(["consent"]);
  });

  it("another tab still open: shutdown here does not end the shared session", async () => {
    const locks = { request: (_n: string, _o: unknown, cb: () => unknown) => Promise.resolve().then(() => cb()), query: async () => ({ held: [{ name: "ouo.tab" }, { name: "ouo.tab" }] }) };
    useLocks(locks);
    ouo.init({ endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 50, persist: { enabled: false } } });
    await ouo.flush();
    await ouo.shutdown();
    await collector.settled();
    expect(collector.events("session.end")).toHaveLength(0);
  });
});

// ---- second round of the review ----

describe("H. consent denied then granted in the same task (a CMP setting a default, then the stored choice)", () => {
  for (const required of [true, false]) {
    it(`consent.required=${required}: the session that starts on the grant survives, is stored and its records are sent`, async () => {
      ouo.init({ endpoint: BASE, serviceName: "web-store", consent: { required }, transport: { flushIntervalMs: 50, persist: { enabled: false } } });
      ouo.setConsent({ telemetry: false });
      ouo.setConsent({ telemetry: true });
      const sid = ouo.getSessionId();
      expect(sid).toMatch(/^[0-9a-f]{32}$/);
      ouo.recordEvent("after.grant");
      await wait(300);
      await ouo.flush();
      await collector.settled();
      expect(ouo.getSessionId()).toBe(sid);
      expect(localStorage.getItem("ouo.session")).toContain(sid!);
      expect(collector.events("after.grant")).toHaveLength(1);
      expect(collector.events("session.start").filter((e) => e.attributes["session.id"] === sid)).toHaveLength(1);
    });
  }
});

describe("I. the fetch wrapper leaves the call as the app made it", () => {
  it("an init whose fields are inherited (a class instance, Object.create) still reaches fetch", async () => {
    ouo.init({ endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 50, persist: { enabled: false } } });
    const defaults = { method: "POST", headers: { "x-app": "1" } };
    const init = Object.create(defaults) as RequestInit;
    await fetch("http://localhost:3000/api/a", init);
    // The app's own object is not written to.
    expect(Object.keys(init)).toEqual([]);
    expect(collector.app[0]!.headers["x-app"]).toBe("1");
  });
});

class SlowClock implements Clock {
  t = 1_700_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.set(this.next, { at: this.t + ms, fn });
    return this.next++;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    this.t = end;
  }
}

describe("J. a batch handed to the outbox while the drainer is in the middle of a run", () => {
  it("is delivered without waiting for another failure, a tab switch or a reload", async () => {
    const clock = new SlowClock();
    const outbox = new MemoryOutbox(1024 * 1024);
    const delivered: string[] = [];
    let failNext = 0;
    let slow: (() => void) | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const text = new TextDecoder().decode(init.body as Uint8Array);
      if (failNext > 0) {
        failNext--;
        return new Response("", { status: 503 });
      }
      if (text === "one" && !delivered.includes("one-started")) {
        delivered.push("one-started");
        await new Promise<void>((r) => (slow = r)); // the drainer's POST of batch one is slow
      }
      delivered.push(text);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const http = new Http({ headers: {}, timeoutMs: 600_000, clock, fetchImpl });
    const drops = new DropCounter();
    let drainer!: OutboxDrainer;
    const queue = new TelemetryQueue<string>({
      signal: "logs", url: "http://c/v1/logs", serialize: (items) => new TextEncoder().encode(items.join(",")), rejected: () => 0, isBypass: () => false, nameOf: () => "e",
      http, outbox: () => outbox, onStored: (id) => drainer.own(id), drops, logger: silentLogger, gate: () => "open", hidden: () => false, clock, random: () => 1,
      settings: { flushIntervalMs: 1000, maxBatchRecords: 10, maxRequestBytes: 1 << 20, maxQueueRecords: 100, retryInitialMs: 1000, retryMaxMs: 30_000 },
    });
    drainer = new OutboxDrainer({
      outbox: () => outbox, http, urls: { logs: "http://c/v1/logs", traces: "http://c/v1/traces" }, rejected: { logs: () => 0, traces: () => 0 }, drops,
      ttlMs: 72 * 3_600_000, retryInitialMs: 1000, retryMaxMs: 30_000, gate: () => "open", hidden: () => false, clock,
    });
    failNext = 1;
    queue.add("one");
    await clock.advance(1000); // flush: 503, handed to the outbox, drainer scheduled
    await clock.advance(1100); // drainer runs and is now waiting on the slow POST of "one"
    expect(delivered).toEqual(["one-started"]);
    failNext = 1;
    queue.add("two");
    await clock.advance(1000); // flush: 503, handed to the outbox while the drainer is running
    slow!();
    await clock.advance(10 * 60_000); // ten minutes, nothing else happens on the page
    queue.close();
    drainer.close();
    expect(delivered.filter((d) => d !== "one-started")).toEqual(["one", "two"]);
  });
});
