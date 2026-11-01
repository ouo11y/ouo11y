/** The delivery layer (src/transport): retry policy, keepalive budget, page hide, offline store, gzip. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createLogger, type DebugLogger } from "../src/logger";
import { Batcher } from "../src/telemetry/batch";
import { Delivery, type DeliveryOptions, type DeliveryRequest } from "../src/transport/delivery";
import { OtlpJsonExporter } from "../src/transport/exporter";
import { KEEPALIVE_MAX_BYTES, KEEPALIVE_MAX_REQUESTS, keepaliveRemaining, releaseKeepalive, reserveKeepalive } from "../src/transport/keepalive";
import { backoffDelay, classifyStatus, parseRetryAfter } from "../src/transport/retry";
import { MemoryStore } from "../src/transport/store";

type Reply = number | "network" | { status: number; retryAfter?: string };

/** A fetch answering from `replies` in order (the last one repeats), recording every call. */
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit; at: number }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, at: Date.now() });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (r === "network") throw new TypeError("Failed to fetch");
    const { status, retryAfter } = typeof r === "number" ? { status: r, retryAfter: undefined } : r;
    return new Response(null, { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

function spyLogger(): DebugLogger & { warns: string[] } {
  const warns: string[] = [];
  return { enabled: true, log: () => undefined, warn: (...a: unknown[]) => void warns.push(a.map(String).join(" ")), warns };
}

const deliveries: Delivery[] = [];
function make(replies: Reply[], opts: Partial<DeliveryOptions> = {}) {
  const f = fakeFetch(replies);
  const store = opts.store === undefined ? new MemoryStore(1 << 20) : opts.store;
  const logger = spyLogger();
  const d = new Delivery({ logger, fetchImpl: f.fetchImpl, baseDelayMs: 4, maxDelayMs: 20, random: () => 0, drainDelayMs: 60_000, ...opts, store });
  deliveries.push(d);
  return { d, store: store as MemoryStore | null, logger, ...f };
}

const req = (bytes = 100, label = "traces"): DeliveryRequest => ({
  url: `http://c.test/v1/${label}`,
  headers: { "content-type": "application/json", Authorization: "Basic eDp5" },
  body: new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(Math.max(0, bytes - 10)) })),
  label,
});

afterEach(() => {
  for (const d of deliveries.splice(0)) d.close();
  // Reset the page-hide flag of any Delivery still listening.
  window.dispatchEvent(new Event("pageshow"));
});

describe("retry policy", () => {
  it("N88: retries OTLP/HTTP's retryable answers (429, 502, 503, 504) and nothing else", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(204)).toBe("ok");
    for (const s of [429, 502, 503, 504]) expect(classifyStatus(s)).toBe("retry");
    for (const s of [100, 302, 304, 400, 401, 403, 404, 408, 413, 415, 500, 501, 505, 599]) expect(classifyStatus(s)).toBe("drop");
  });

  it("reads Retry-After as seconds or as an HTTP date", () => {
    const now = Date.parse("2026-10-24T10:00:00Z");
    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Sat, 24 Oct 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Sat, 24 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("backs off exponentially with jitter, capped", () => {
    const p = { baseDelayMs: 1000, maxDelayMs: 30_000 };
    expect(backoffDelay(1, p, () => 0)).toBe(500);
    expect(backoffDelay(1, p, () => 1)).toBe(1000);
    expect(backoffDelay(3, p, () => 0)).toBe(2000);
    expect(backoffDelay(3, p, () => 1)).toBe(4000);
    expect(backoffDelay(20, p, () => 1)).toBe(30_000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(4, p);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});

describe("keepalive budget", () => {
  it("caps the bytes and the number of keepalive requests in flight", () => {
    expect(keepaliveRemaining()).toBe(KEEPALIVE_MAX_BYTES);
    expect(reserveKeepalive(KEEPALIVE_MAX_BYTES + 1)).toBe(false);
    expect(reserveKeepalive(50_000)).toBe(true);
    expect(reserveKeepalive(20_000)).toBe(false);
    releaseKeepalive(50_000);
    for (let i = 0; i < KEEPALIVE_MAX_REQUESTS; i++) expect(reserveKeepalive(10)).toBe(true);
    expect(keepaliveRemaining()).toBe(0);
    expect(reserveKeepalive(10)).toBe(false);
    for (let i = 0; i < KEEPALIVE_MAX_REQUESTS; i++) releaseKeepalive(10);
    expect(keepaliveRemaining()).toBe(KEEPALIVE_MAX_BYTES);
  });
});

describe("Delivery while the page is visible", () => {
  it("retries a 503 with backoff until it is accepted", async () => {
    const { d, calls } = make([503, 503, 200]);
    expect(await d.send(req())).toBe("retrying");
    await d.settled();
    expect(calls).toHaveLength(3);
    expect(d.stats).toMatchObject({ sent: 1, retried: 2, dropped: 0 });
  });

  it("retries network errors", async () => {
    const { d, calls } = make(["network", 200]);
    await d.send(req());
    await d.settled();
    expect(calls).toHaveLength(2);
    expect(d.stats.sent).toBe(1);
  });

  it("waits what 429 Retry-After asks", async () => {
    const { d, calls } = make([{ status: 429, retryAfter: "1" }, 200]);
    await d.send(req());
    await d.settled();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950);
  });

  it("parks a request whose Retry-After is longer than it holds requests in memory", async () => {
    const { d, calls, store } = make([{ status: 503, retryAfter: "120" }]);
    await d.send(req());
    await d.settled();
    expect(calls).toHaveLength(1);
    const [entry] = await store!.oldest(1);
    expect(entry!.notBefore - Date.now()).toBeGreaterThan(110_000);
    expect(d.stats.queued).toBe(1);
  });

  it("never retries an answer but 429 and 502-504, and counts and logs the drop", async () => {
    for (const status of [400, 401, 404, 408, 413, 500, 501]) {
      const { d, calls, logger } = make([status, 200]);
      expect(await d.send(req(300))).toBe("dropped");
      await d.settled();
      expect(calls).toHaveLength(1);
      expect(d.stats).toMatchObject({ dropped: 1, droppedBytes: 300, dropReasons: { rejected: 1 } });
      expect(logger.warns.join()).toContain(`HTTP ${status}`);
    }
    for (const status of [502, 504]) {
      const { d, calls } = make([status, 200]);
      await d.send(req());
      await d.settled();
      expect(calls).toHaveLength(2);
      expect(d.stats).toMatchObject({ sent: 1, retried: 1, dropped: 0 });
    }
  });

  it("N88: a request the collector answers 500 to every time costs one attempt, not the retries and the store", async () => {
    const { d, calls, store } = make([500, 500, 500, 500, 500], { maxAttempts: 3 });
    expect(await d.send(req())).toBe("dropped");
    await d.settled();
    expect(calls).toHaveLength(1);
    expect(store!.size()).toBe(0);
    expect(d.stats).toMatchObject({ retried: 0, queued: 0, dropReasons: { rejected: 1 } });
  });

  it("stores the request once the attempts are spent, and sends it when the collector is back", async () => {
    const { d, calls, store } = make([503, 503, 503, 200], { maxAttempts: 3 });
    await d.send(req());
    await d.settled();
    expect(calls).toHaveLength(3);
    expect(store!.size()).toBe(1);
    expect(d.stats.queued).toBe(1);
    await d.drain();
    expect(calls).toHaveLength(4);
    expect(store!.size()).toBe(0);
    expect(d.stats.sent).toBe(1);
  });

  it("drops instead of storing when the offline store is off", async () => {
    const { d } = make([503], { maxAttempts: 2, store: null });
    await d.send(req());
    await d.settled();
    expect(d.stats.dropReasons).toEqual({ no_store: 1 });
  });

  it("gzips bodies of 1 KB or more and counts the bytes saved", async () => {
    const { d, calls } = make([200]);
    const r = req(20_000);
    await d.send(r);
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>)["content-encoding"]).toBe("gzip");
    expect(gunzipSync(init.body as Uint8Array)).toEqual(Buffer.from(r.body));
    expect(d.stats.rawBytes).toBe(r.body.byteLength);
    expect(d.stats.wireBytes).toBeLessThan(r.body.byteLength / 10);
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
  });

  it("sends small bodies and compression: false uncompressed", async () => {
    const small = make([200]);
    await small.d.send(req(500));
    expect((small.calls[0]!.init.headers as Record<string, string>)["content-encoding"]).toBeUndefined();
    const off = make([200], { compression: false });
    await off.d.send(req(20_000));
    expect((off.calls[0]!.init.headers as Record<string, string>)["content-encoding"]).toBeUndefined();
  });

  it("aborts a request that takes longer than the timeout and retries it", async () => {
    let n = 0;
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => {
      n++;
      if (n > 1) return Promise.resolve(new Response(null, { status: 200 }));
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    const { d } = make([], { fetchImpl, timeoutMs: 30 });
    await d.send(req());
    await d.settled();
    expect(n).toBe(2);
    expect(d.stats.sent).toBe(1);
  });
});

describe("Delivery offline", () => {
  it("stores while navigator.onLine is false and sends on the online event", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { d, calls, store } = make([200]);
    expect(await d.send(req())).toBe("queued");
    expect(await d.send(req(200, "logs"))).toBe("queued");
    expect(calls).toHaveLength(0);
    expect(store!.size()).toBe(2);
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(store!.size()).toBe(0));
    expect(calls.map((c) => c.url)).toEqual(["http://c.test/v1/traces", "http://c.test/v1/logs"]);
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Basic eDp5");
  });

  it("evicts the oldest stored requests beyond the cap and counts them", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { d, store } = make([200], { store: new MemoryStore(2500) });
    for (let i = 0; i < 4; i++) await d.send(req(1000));
    expect(store!.size()).toBe(2);
    expect(d.stats.dropReasons).toEqual({ store_full: 2 });
    expect(await d.send(req(3000))).toBe("dropped");
    expect(d.stats.dropReasons.too_large).toBe(1);
  });

  it("N88: a stored request answered 500 is dropped and the drain goes on to the next", async () => {
    const store = new MemoryStore(1 << 20);
    const old = { url: "http://c.test/v1/logs", headers: { Authorization: "Basic eDp5" }, notBefore: 0, attempts: 0, createdAt: Date.now() };
    await store.put({ ...old, body: new Uint8Array([1]) });
    await store.put({ ...old, body: new Uint8Array([2]) });
    const { d, calls } = make([500, 200], { store, drainDelayMs: 0 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await d.settled();
    await vi.waitFor(() => expect(store.size()).toBe(0));
    expect(d.stats).toMatchObject({ sent: 1, dropReasons: { rejected: 1 } });
  });

  it("sends the previous page's requests at start, drops expired ones, and stops at the first failure", async () => {
    const store = new MemoryStore(1 << 20);
    const old = { url: "http://c.test/v1/logs", headers: { Authorization: "Basic eDp5" }, notBefore: 0, attempts: 0 };
    await store.put({ ...old, body: new Uint8Array([1]), createdAt: Date.now() - 2 * 86_400_000 });
    await store.put({ ...old, body: new Uint8Array([2]), createdAt: Date.now() });
    await store.put({ ...old, body: new Uint8Array([3]), createdAt: Date.now() });
    const { d, calls } = make([200, 503], { store, drainDelayMs: 0 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await d.settled();
    expect(d.stats).toMatchObject({ sent: 1, dropReasons: { expired: 1 } });
    const left = await store.oldest(10);
    expect(left).toHaveLength(1);
    expect(left[0]!.attempts).toBe(1);
    expect(left[0]!.notBefore).toBeGreaterThan(Date.now());
  });
});

describe("Delivery at page hide", () => {
  it("sends at once with keepalive and no gzip: fetch is called before send returns", () => {
    const { d, calls } = make([200]);
    window.dispatchEvent(new Event("pagehide"));
    void d.send(req(20_000));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.keepalive).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>)["content-encoding"]).toBeUndefined();
  });

  it("treats a hidden page like an unloading one", async () => {
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { d, calls } = make([200]);
    void d.send(req(5000));
    expect(calls[0]!.init.keepalive).toBe(true);
    vis.mockRestore();
  });

  it("stores a request over the keepalive budget and removes it when the plain request arrives", async () => {
    const { d, calls, store } = make([200]);
    window.dispatchEvent(new Event("pagehide"));
    expect(await d.send(req(KEEPALIVE_MAX_BYTES + 1000, "replay"))).toBe("sent");
    // The plain request may await gzip: the page is still alive if it gets that far.
    expect((calls[0]!.init.headers as Record<string, string>)["content-encoding"]).toBe("gzip");
    expect(store!.size()).toBe(0);
  });

  it("keeps it stored when the plain request fails (the page was closed)", async () => {
    const { d, store } = make(["network"]);
    window.dispatchEvent(new Event("pagehide"));
    expect(await d.send(req(KEEPALIVE_MAX_BYTES + 1000, "replay"))).toBe("queued");
    expect(store!.size()).toBe(1);
  });

  it("N88: drops a keepalive request answered 500 instead of storing it for the next page", async () => {
    const { d, calls, store } = make([500, 200]);
    window.dispatchEvent(new Event("pagehide"));
    expect(await d.send(req())).toBe("dropped");
    expect(calls).toHaveLength(1);
    expect(store!.size()).toBe(0);
    expect(d.stats.dropReasons).toEqual({ rejected: 1 });
  });

  it("N88: over the keepalive budget, a plain request answered 500 removes the copy stored for the next page", async () => {
    const { d, store } = make([500]);
    window.dispatchEvent(new Event("pagehide"));
    expect(await d.send(req(KEEPALIVE_MAX_BYTES + 1000, "replay"))).toBe("dropped");
    expect(store!.size()).toBe(0);
  });

  it("stores a failed keepalive request without retrying it", async () => {
    const { d, calls, store } = make([503, 200]);
    window.dispatchEvent(new Event("pagehide"));
    expect(await d.send(req())).toBe("queued");
    expect(calls).toHaveLength(1);
    expect(store!.size()).toBe(1);
  });

  it("uses sendBeacon over the budget when enabled", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    try {
      const { d, calls, store } = make([200], { beacon: true });
      window.dispatchEvent(new Event("pagehide"));
      for (let i = 0; i < KEEPALIVE_MAX_REQUESTS; i++) reserveKeepalive(1);
      expect(await d.send(req(1000, "logs"))).toBe("sent");
      expect(beacon).toHaveBeenCalledWith("http://c.test/v1/logs", expect.any(Blob));
      expect(calls).toHaveLength(0);
      expect(store!.size()).toBe(0);
    } finally {
      for (let i = 0; i < KEEPALIVE_MAX_REQUESTS; i++) releaseKeepalive(1);
      delete (navigator as { sendBeacon?: unknown }).sendBeacon;
    }
  });

  it("wakes a request waiting to retry and sends it with keepalive", async () => {
    const { d, calls } = make([503, 200], { baseDelayMs: 60_000, maxDelayMs: 60_000, maxRetryAfterMs: 120_000 });
    await d.send(req());
    window.dispatchEvent(new Event("pagehide"));
    await d.settled();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.keepalive).toBe(true);
    expect(d.stats.sent).toBe(1);
  });
});

describe("OTLP exporter", () => {
  const serializer = { serializeRequest: (items: string[]) => new TextEncoder().encode(JSON.stringify(items)) };

  it("sends one body while visible, and splits a batch to fit the keepalive budget at page hide", async () => {
    const { d, calls } = make([200]);
    const exporter = new OtlpJsonExporter(serializer, "logs", { url: "http://c.test/v1/logs", headers: {}, delivery: d });
    const items = Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(10_000, "x"));
    expect(exporter.parts(items)).toHaveLength(1);
    window.dispatchEvent(new Event("pagehide"));
    const parts = exporter.parts(items);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    expect(parts.flatMap((p) => JSON.parse(new TextDecoder().decode(p)) as string[])).toEqual(items);
    const done = vi.fn();
    exporter.export(items.slice(0, 2), done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ code: 0 }));
    expect(calls[0]!.init.keepalive).toBe(true);
  });
});

describe("Batcher", () => {
  it("reports records dropped by a full queue", () => {
    const onDrop = vi.fn();
    const b = new Batcher<number>({ export: () => undefined, shutdown: async () => undefined }, { scheduledDelayMillis: 1000, maxExportBatchSize: 100, maxQueueSize: 2, onDrop });
    for (let i = 0; i < 5; i++) b.add(i);
    expect(onDrop).toHaveBeenCalledTimes(3);
    void b.flush();
  });

  it("counts them in the delivery stats", () => {
    const { d } = make([200], { logger: createLogger(false) });
    d.countQueueDrop("traces");
    expect(d.stats.dropReasons).toEqual({ queue_full: 1 });
  });
});
