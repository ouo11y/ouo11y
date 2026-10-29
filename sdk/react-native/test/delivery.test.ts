import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { createLogger } from "../src/logger";
import type { Clock } from "../src/session/clock";
import { MemoryAsyncStorage } from "../src/session/storage";
import { utf8Decode } from "../src/transport/exporter";
import { OUTBOX_KEY, Outbox, retryable, type SendResult } from "../src/transport/outbox";
import { createSend, parseRetryAfter } from "../src/transport/send";
import { baseOptions, ENDPOINT, g, installErrorUtils, installFetchStub, waitFor } from "./support/otlp";

const logger = createLogger(false);
const flushPromises = () => new Promise((r) => setTimeout(r, 0));

/** Manual clock: timers run when `advance` passes them. */
function fakeClock(start = 1_760_000_000_000): Clock & { advance(ms: number): Promise<void>; pending(): number[] } {
  let now = start;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      timers = timers.filter((t) => t.id !== h);
    },
    pending: () => timers.map((t) => t.at - now),
    async advance(ms) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t);
        t.fn();
      }
      for (let i = 0; i < 10; i++) await flushPromises();
    },
  };
}

/** A collector that answers with the scripted statuses in order, then 200. */
function collector(statuses: Array<number | SendResult> = []) {
  const bodies: string[] = [];
  const send = vi.fn(async (_url: string, body: string): Promise<SendResult> => {
    bodies.push(body);
    const next = statuses.shift() ?? 200;
    return typeof next === "number" ? { status: next } : next;
  });
  return { send, bodies };
}

/** Lets the drain a put started run to its end (without starting another). */
async function settle(_outbox: Outbox): Promise<void> {
  for (let i = 0; i < 20; i++) await flushPromises();
}

describe("outbox", () => {
  it("persists a request, sends it and forgets it", async () => {
    const storage = new MemoryAsyncStorage();
    const c = collector();
    const outbox = new Outbox({ storage, send: c.send, logger });
    await outbox.put(`${ENDPOINT}/v1/logs`, '{"resourceLogs":[]}');
    await settle(outbox);
    expect(c.send).toHaveBeenCalledWith(`${ENDPOINT}/v1/logs`, '{"resourceLogs":[]}');
    expect(outbox.size).toBe(0);
    expect(JSON.parse(storage.peek(OUTBOX_KEY)!).items).toEqual([]);
    expect(storage.peek(`${OUTBOX_KEY}.1`)).toBeNull();
  });

  it("C11: an outage keeps every request, the next launch sends them in order", async () => {
    const storage = new MemoryAsyncStorage();
    const clock = fakeClock();
    const down = collector([0, 0, 0, 0]);
    const first = new Outbox({ storage, send: down.send, logger, clock });
    for (const n of [1, 2, 3]) await first.put(`${ENDPOINT}/v1/traces`, `batch-${n}`);
    await settle(first);
    expect(first.size).toBe(3);
    expect(down.send).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toEqual([1000]);
    first.stop();

    const up = collector();
    const next = new Outbox({ storage: storage.clone(), send: up.send, logger, clock });
    await next.drain();
    expect(up.bodies).toEqual(["batch-1", "batch-2", "batch-3"]);
    expect(next.size).toBe(0);
  });

  it("retries with a doubling backoff capped at 30 s, honouring Retry-After", async () => {
    const clock = fakeClock();
    const c = collector([503, 0, { status: 429, retryAfterMs: 45_000 }, 0, 0, 0, 0, 0]);
    const outbox = new Outbox({ storage: new MemoryAsyncStorage(), send: c.send, logger, clock });
    await outbox.put("u", "a");
    await settle(outbox);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const [w] = clock.pending();
      waits.push(w!);
      await clock.advance(w!);
    }
    expect(waits).toEqual([1000, 2000, 45_000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(c.send).toHaveBeenCalledTimes(9);
    expect(outbox.size).toBe(0);
  });

  it("a put during the backoff waits for it; drain() tries at once", async () => {
    const clock = fakeClock();
    const c = collector([0]);
    const outbox = new Outbox({ storage: new MemoryAsyncStorage(), send: c.send, logger, clock });
    await outbox.put("u", "a");
    await settle(outbox);
    await outbox.put("u", "b");
    await flushPromises();
    expect(c.send).toHaveBeenCalledTimes(1);
    await outbox.drain();
    expect(c.bodies).toEqual(["a", "a", "b"]);
    expect(clock.pending()).toEqual([]);
  });

  it("drops a rejected request (4xx but 408 and 429) and goes on", async () => {
    expect([0, 408, 429, 500, 503].every(retryable)).toBe(true);
    expect([400, 401, 403, 404, 413].some(retryable)).toBe(false);
    const c = collector([401]);
    const outbox = new Outbox({ storage: new MemoryAsyncStorage(), send: c.send, logger });
    await outbox.put("u", "a");
    await outbox.put("u", "b");
    await settle(outbox);
    expect(c.bodies).toEqual(["a", "b"]);
    expect(outbox.stats).toEqual({ sent: 1, rejected: 1, dropped: 0 });
  });

  it("a kill mid-request resends it on the next launch", async () => {
    const storage = new MemoryAsyncStorage();
    const hung = vi.fn(() => new Promise<SendResult>(() => undefined));
    const first = new Outbox({ storage, send: hung, logger });
    await first.put("u", "in flight");
    await flushPromises();
    expect(hung).toHaveBeenCalledTimes(1);

    const c = collector();
    await new Outbox({ storage: storage.clone(), send: c.send, logger }).drain();
    expect(c.bodies).toEqual(["in flight"]);
  });

  it("is bounded: the oldest are dropped beyond maxBytes or maxEntries", async () => {
    const storage = new MemoryAsyncStorage();
    const down = collector(Array(20).fill(0));
    const clock = fakeClock();
    const byBytes = new Outbox({ storage, send: down.send, logger, clock, maxBytes: 25 });
    for (const n of [1, 2, 3, 4, 5]) await byBytes.put("u", `ten bytes${n}`);
    expect(byBytes.size).toBe(2);
    expect(byBytes.stats.dropped).toBe(3);
    expect(storage.peek(`${OUTBOX_KEY}.1`)).toBeNull();

    const countStore = new MemoryAsyncStorage();
    const byCount = new Outbox({ storage: countStore, send: down.send, logger, clock, maxEntries: 3 });
    for (const n of [1, 2, 3, 4, 5]) await byCount.put("u", `${n}`);
    const up = collector();
    await new Outbox({ storage: countStore.clone(), send: up.send, logger, clock }).drain();
    expect(up.bodies).toEqual(["3", "4", "5"]);
  });

  it("drops requests older than maxAgeMs unsent", async () => {
    const storage = new MemoryAsyncStorage();
    const clock = fakeClock();
    const first = new Outbox({ storage, send: collector([0]).send, logger, clock });
    await first.put("u", "old");
    await settle(first);
    first.stop();
    await clock.advance(24 * 3600 * 1000 + 1);
    const c = collector();
    const next = new Outbox({ storage: storage.clone(), send: c.send, logger, clock });
    await next.drain();
    expect(c.send).not.toHaveBeenCalled();
    expect(next.stats.dropped).toBe(1);
  });

  it("skips an index entry whose body was never written (killed in between)", async () => {
    const storage = new MemoryAsyncStorage();
    await storage.setItem(OUTBOX_KEY, JSON.stringify({ next: 3, items: [{ id: 1, url: "u", bytes: 1, at: Date.now() }, { id: 2, url: "u", bytes: 1, at: Date.now() }] }));
    await storage.setItem(`${OUTBOX_KEY}.2`, "two");
    const c = collector();
    const outbox = new Outbox({ storage, send: c.send, logger });
    await outbox.drain();
    expect(c.bodies).toEqual(["two"]);
    // New ids continue after the stored ones.
    await outbox.put("u", "three");
    await settle(outbox);
    expect(storage.peek(`${OUTBOX_KEY}.3`)).toBeNull();
    expect(c.bodies).toEqual(["two", "three"]);
  });

  it("a storage that fails still sends from memory", async () => {
    const broken = {
      getItem: () => Promise.reject(new Error("disk")),
      setItem: () => Promise.reject(new Error("disk")),
      removeItem: () => Promise.reject(new Error("disk")),
    };
    const c = collector();
    const outbox = new Outbox({ storage: broken, send: c.send, logger });
    await outbox.put("u", "a");
    await settle(outbox);
    expect(c.bodies).toEqual(["a"]);
  });
});

describe("send", () => {
  it("N48: goes through the native module, which gzips, with the credential and content-type", async () => {
    const postOtlp = vi.fn(async () => ({ status: 200 }));
    const send = createSend({ Authorization: "Basic x" }, { postOtlp });
    expect(await send("u", "{}")).toEqual({ status: 200 });
    expect(postOtlp).toHaveBeenCalledWith("u", { "content-type": "application/json", Authorization: "Basic x" }, "{}");
  });

  it("falls back to fetch without the native module; a thrown fetch is status 0", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      calls.push(init);
      if (calls.length === 2) throw new TypeError("Network request failed");
      return new Response("{}", { status: 503, headers: { "retry-after": "7" } });
    }) as typeof fetch;
    const send = createSend({ Authorization: "Basic x" }, undefined);
    expect(await send("u", "{}")).toEqual({ status: 503, retryAfterMs: 7000 });
    expect(await send("u", "{}")).toEqual({ status: 0 });
    expect(calls[0]!.body).toBe("{}");
    expect(calls[0]!.headers).toEqual({ "content-type": "application/json", Authorization: "Basic x" });
  });

  it("parses Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:10 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("decodes UTF-8 without TextDecoder (Hermes)", () => {
    const text = '{"body":"héllo ✓ 🙂"}';
    const bytes = new TextEncoder().encode(text);
    const saved = globalThis.TextDecoder;
    try {
      (globalThis as { TextDecoder?: unknown }).TextDecoder = undefined;
      expect(utf8Decode(bytes)).toBe(text);
      expect(utf8Decode(new TextEncoder().encode("x".repeat(10_000)))).toHaveLength(10_000);
    } finally {
      globalThis.TextDecoder = saved;
    }
  });
});

describe("initRUM delivery", () => {
  beforeEach(() => {
    installErrorUtils();
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    delete g.__ouoSessionProcessState;
  });

  it("C11.1: a run with the collector refused loses nothing after the next launch", async () => {
    const storage = new MemoryAsyncStorage();
    globalThis.fetch = (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch;
    const rum = initRUM(baseOptions(storage)) as RUMInternal;
    await rum.ready;
    rum.addEvent("checkout.offline", { step: 1 });
    rum.withSpan("offline work", () => undefined);
    await rum.flush();
    const offlineSession = rum.session.id();
    await rum._uninstall();
    delete g.__ouoSessionProcessState;

    const captured = installFetchStub();
    const next = initRUM(baseOptions(storage.clone())) as RUMInternal;
    await next.ready;
    await waitFor(() => captured.byName("checkout.offline").length > 0 && captured.spans.some((s) => s.name === "offline work"));
    const event = captured.byName("checkout.offline")[0]!;
    expect(event.attributes.find((a) => a.key === "session.id")?.value.stringValue).toBe(offlineSession);
    expect(captured.byName("session.start").some((l) => l.attributes.find((a) => a.key === "session.id")?.value.stringValue === offlineSession)).toBe(true);
  });

  it("transport.offline false keeps nothing for the next launch", async () => {
    const storage = new MemoryAsyncStorage();
    globalThis.fetch = (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch;
    const rum = initRUM({ ...baseOptions(storage), transport: { offline: false } }) as RUMInternal;
    await rum.ready;
    await rum.flush();
    expect(storage.peek(OUTBOX_KEY)).toBeNull();
  });
});
