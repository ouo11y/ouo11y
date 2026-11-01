import { guard } from "../guard";
import type { DebugLogger } from "../logger";
import type { DeliveryStats } from "../types";
import { systemClock, type Clock, type TimerHandle } from "../session/clock";
import { canGzip, GZIP_MIN_BYTES, gzipBytes } from "./gzip";
import { keepaliveRemaining, releaseKeepalive, reserveKeepalive } from "./keepalive";
import { backoffDelay, classifyStatus, parseRetryAfter } from "./retry";
import type { OfflineStore, StoredRequest } from "./store";

export type { DeliveryStats };

/** One POST to the collector: OTLP/HTTP JSON or a replay chunk. */
export interface DeliveryRequest {
  url: string;
  /** `Authorization`, `content-type` and any other header; `content-encoding` is added here. */
  headers: Record<string, string>;
  /** Uncompressed body. */
  body: Uint8Array;
  /** `traces`, `logs` or `replay`: for the debug log only. */
  label: string;
}

/**
 * `sent`: the collector answered 2xx (or the beacon was queued by the browser). `retrying`: the
 * first attempt failed and retries continue in the background. `queued`: kept in the offline
 * store for later. `dropped`: lost, and counted in {@link DeliveryStats}.
 */
export type Outcome = "sent" | "retrying" | "queued" | "dropped";

/** Why a request was lost. */
export type DropReason = keyof DeliveryStats["dropReasons"];

export interface DeliveryOptions {
  logger: DebugLogger;
  /** Where unsent requests wait; null drops them instead. */
  store: OfflineStore | null;
  /** gzip bodies of 1 KB or more with CompressionStream when the browser has it. Default true. */
  compression?: boolean;
  /** Attempts per request, the first included, before it goes to the store. Default 5. */
  maxAttempts?: number;
  /** Default 1000 ms. */
  baseDelayMs?: number;
  /** Default 30 s. */
  maxDelayMs?: number;
  /** A `Retry-After` longer than this sends the request to the store with that wait. Default 60 s. */
  maxRetryAfterMs?: number;
  /** Stored requests older than this are dropped unsent. Default 24 h. */
  maxAgeMs?: number;
  /** Abort a request after this long (then retried). Default 30 s. */
  timeoutMs?: number;
  /**
   * At page hide, use `navigator.sendBeacon` when the keepalive budget is spent. A beacon cannot
   * carry `Authorization`, so this only works through a first-party proxy that adds it.
   * Default false.
   */
  beacon?: boolean;
  /** Send what the store holds this long after start (the previous page's leftovers). Default 1000 ms. */
  drainDelayMs?: number;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  random?: () => number;
}

type Attempt = { kind: "ok" } | { kind: "retry"; why: string; retryAfterMs?: number | undefined } | { kind: "drop"; why: string };

const DRAIN_LOCK = "ouo-delivery-drain";
const DRAIN_BATCH = 10;

/** fetch that bypasses the OTel fetch instrumentation wrapper so ingest requests do not become spans. */
export function rawFetch(): typeof fetch {
  const f = globalThis.fetch as typeof fetch & { __original?: typeof fetch };
  return typeof f.__original === "function" ? f.__original : f;
}

function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function labelOf(url: string): string {
  return url.endsWith("/v1/replay/chunks") ? "replay" : url.endsWith("/v1/logs") ? "logs" : url.endsWith("/v1/traces") ? "traces" : url;
}

/**
 * Sends every ingest request and makes losing one the exception (checklist N36, part A):
 *
 * - While the page is visible: gzip, then retry network errors, timeouts, 429, 502, 503 and 504
 *   with exponential backoff and jitter, honouring `Retry-After`, up to `maxAttempts`; any other
 *   status is dropped (`rejected`). What still fails goes to the offline store.
 * - Offline (`navigator.onLine` false): straight to the store.
 * - Hidden or unloading (`visibilitychange` to hidden, `pagehide`): no await before the request
 *   leaves (the page may be gone after this task), so no gzip; `keepalive` within the 64 KB
 *   budget, else a beacon when enabled, else the store plus a plain request in case the page
 *   lives on. A request that fails then goes to the store at once.
 * - The store is sent on `online`, when the page is shown again, after any success, and on the
 *   next page load of the origin (one tab at a time, with the Web Locks API).
 *
 * Delivery is at least once: a request stored at page hide whose plain request also arrived is
 * sent again by the next page. Tempo, Loki and the replay receiver tolerate the duplicate
 * (same span id, same log line, same chunk seq).
 */
export class Delivery {
  readonly stats: DeliveryStats = { sent: 0, retried: 0, queued: 0, dropped: 0, droppedBytes: 0, dropReasons: {}, rawBytes: 0, wireBytes: 0 };
  private readonly logger: DebugLogger;
  private readonly store: OfflineStore | null;
  private readonly compression: boolean;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;
  private readonly beacon: boolean;
  private readonly fetchImpl: (() => typeof fetch) | null;
  private readonly clock: Clock;
  private readonly random: () => number;

  private pageHidden = false;
  private closed = false;
  private readonly waiting = new Set<() => void>();
  private readonly inflight = new Set<Promise<unknown>>();
  private draining: Promise<void> | null = null;
  private drainTimer: TimerHandle | null = null;
  private drainFailures = 0;
  /** The store may hold something: unknown at start, set on every park, cleared when a drain finds it empty. */
  private storeDirty = true;
  private readonly unlisten: Array<() => void> = [];

  constructor(opts: DeliveryOptions) {
    this.logger = opts.logger;
    this.store = opts.store;
    this.compression = opts.compression !== false;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.beacon = opts.beacon === true;
    this.fetchImpl = opts.fetchImpl ? () => opts.fetchImpl! : null;
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;

    // Capture phase, and the SDK creates this before its own pagehide flush: the flag is set
    // before that flush runs (Chromium fires pagehide while the page still reports visible).
    this.listen(globalThis, "pagehide", () => {
      this.pageHidden = true;
      this.wake();
    });
    this.listen(globalThis, "pageshow", () => {
      this.pageHidden = false;
    });
    this.listen(globalThis, "online", () => this.scheduleDrain(0));
    if (typeof document !== "undefined") {
      this.listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") this.wake();
        else this.scheduleDrain(0);
      });
    }
    if (this.store) this.scheduleDrain(opts.drainDelayMs ?? 1000);
  }

  /** True while the page is hidden or unloading: requests must leave without awaiting anything. */
  urgent(): boolean {
    return this.pageHidden || (typeof document !== "undefined" && document.visibilityState === "hidden");
  }

  /**
   * Delivers `req`. Resolves after the first attempt (retries continue in the background) and
   * never rejects. `urgent` forces the page-hide path (the replay chunker's unload flush).
   */
  send(req: DeliveryRequest, opts: { urgent?: boolean } = {}): Promise<Outcome> {
    return this.track(this.deliver(req, opts.urgent === true));
  }

  /** Resolves when every request, retries included, is sent, stored or dropped. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0 || this.draining) await Promise.all([...this.inflight, this.draining]);
  }

  /** Sends what the store holds, oldest first; stops at the first request that fails again. */
  drain(): Promise<void> {
    if (!this.store || this.closed) return Promise.resolve();
    if (this.draining) return this.draining;
    const run = this.withLock(() => this.drainStore()).finally(() => {
      this.draining = null;
    });
    this.draining = run;
    return run;
  }

  close(): void {
    this.closed = true;
    for (const off of this.unlisten.splice(0)) off();
    if (this.drainTimer !== null) this.clock.clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.wake();
  }

  // ---- sending ----

  private async deliver(req: DeliveryRequest, forceUrgent: boolean): Promise<Outcome> {
    if (forceUrgent || this.urgent()) return this.sendUrgent(req);
    if (this.store && offline()) return this.park(req, "offline");
    const first = await this.attempt(req, false);
    if (first.kind === "ok") return this.sent();
    if (first.kind === "drop") return this.drop(req, "rejected", first.why);
    this.track(this.retryLoop(req, first));
    return "retrying";
  }

  private async retryLoop(req: DeliveryRequest, failed: Attempt & { kind: "retry" }): Promise<Outcome> {
    let last = failed;
    for (let attempt = 1; ; attempt++) {
      if (attempt >= this.maxAttempts) return this.park(req, `${attempt} attempts failed, last: ${last.why}`);
      const delay = last.retryAfterMs ?? backoffDelay(attempt, { baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs }, this.random);
      if (delay > this.maxRetryAfterMs) return this.park(req, `Retry-After ${Math.round(delay / 1000)} s`, this.clock.now() + delay);
      this.stats.retried++;
      this.logger.log(`${req.label}: ${last.why}, retry ${attempt} in ${delay} ms`);
      await this.sleep(delay);
      if (this.closed || this.urgent()) return this.sendUrgent(req);
      if (this.store && offline()) return this.park(req, "offline");
      const res = await this.attempt(req, false);
      if (res.kind === "ok") return this.sent();
      if (res.kind === "drop") return this.drop(req, "rejected", res.why);
      last = res;
    }
  }

  /** The page-hide path. Nothing before the request is awaited. */
  private sendUrgent(req: DeliveryRequest): Promise<Outcome> {
    if (keepaliveRemaining() >= req.body.byteLength) {
      return this.attempt(req, true).then((res) =>
        res.kind === "ok" ? this.sent() : res.kind === "drop" ? this.drop(req, "rejected", res.why) : this.park(req, `${res.why} at page hide`),
      );
    }
    if (this.beacon && this.sendBeacon(req)) {
      this.logger.log(`${req.label}: ${req.body.byteLength} B by beacon at page hide`);
      return Promise.resolve(this.sent());
    }
    // Over the keepalive budget: keep it for the next page load, and send it anyway in case
    // this page lives on (a tab switch rather than a close).
    const stored = this.park(req, "over the keepalive budget at page hide");
    return this.attempt(req, false).then(async (res) => {
      if (res.kind === "retry") return stored;
      const outcome = await stored;
      const id = this.lastParkedId.get(req);
      if (outcome === "queued" && id !== undefined) await this.store!.delete(id);
      return res.kind === "ok" ? this.sent() : this.drop(req, "rejected", res.why);
    });
  }

  /** Ids of requests parked by {@link sendUrgent}, to remove them when the plain request arrives. */
  private readonly lastParkedId = new WeakMap<DeliveryRequest, number>();

  /**
   * One request. `urgent` skips compression so nothing is awaited before fetch is called. Uses
   * `keepalive` whenever the budget allows, so a page closed mid-request still completes it.
   */
  private async attempt(req: DeliveryRequest, urgent: boolean): Promise<Attempt> {
    let body = req.body;
    const headers: Record<string, string> = { ...req.headers };
    if (!urgent && this.compression && body.byteLength >= GZIP_MIN_BYTES && canGzip()) {
      try {
        const gz = await gzipBytes(body);
        if (gz.byteLength < body.byteLength) {
          body = gz;
          headers["content-encoding"] = "gzip";
        }
      } catch (err) {
        this.logger.warn(`${req.label}: gzip failed, sending uncompressed`, err);
      }
    }
    const res = await this.post(req.url, body, headers);
    if (res.kind === "ok") {
      this.stats.rawBytes += req.body.byteLength;
      this.stats.wireBytes += body.byteLength;
      const gz = headers["content-encoding"] === "gzip" ? `, gzip ${body.byteLength} B (${Math.round(100 - (100 * body.byteLength) / req.body.byteLength)}% saved)` : "";
      this.logger.log(`${req.label}: sent ${req.body.byteLength} B${gz}${urgent ? " at page hide" : ""}`);
    }
    return res;
  }

  private post(url: string, body: Uint8Array, headers: Record<string, string>): Promise<Attempt> {
    const keepalive = reserveKeepalive(body.byteLength);
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? this.clock.setTimeout(() => abort.abort(), this.timeoutMs) : null;
    let res: Promise<Response>;
    try {
      res = (this.fetchImpl ? this.fetchImpl() : rawFetch())(url, {
        method: "POST",
        headers,
        body: body as BodyInit,
        keepalive,
        // Same-origin or CORS alike; no cookies to a first-party proxy route.
        credentials: "omit",
        ...(abort ? { signal: abort.signal } : {}),
      });
    } catch (err) {
      res = Promise.reject(err);
    }
    return res
      .then(
        (r): Attempt => {
          const verdict = classifyStatus(r.status);
          if (verdict === "ok") return { kind: "ok" };
          if (verdict === "drop") return { kind: "drop", why: `HTTP ${r.status}` };
          return { kind: "retry", why: `HTTP ${r.status}`, retryAfterMs: parseRetryAfter(r.headers.get("retry-after"), Date.now()) };
        },
        (err: unknown): Attempt => ({ kind: "retry", why: (err as { name?: string } | null)?.name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : "network error" }),
      )
      .finally(() => {
        if (keepalive) releaseKeepalive(body.byteLength);
        if (timer !== null) this.clock.clearTimeout(timer);
      });
  }

  private sendBeacon(req: DeliveryRequest): boolean {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
    try {
      return navigator.sendBeacon(req.url, new Blob([req.body as BlobPart], { type: req.headers["content-type"] ?? "application/json" }));
    } catch {
      return false;
    }
  }

  // ---- outcomes ----

  private sent(): Outcome {
    this.stats.sent++;
    // The collector is reachable again: send what waited.
    if (this.storeDirty && this.store && !this.draining) this.scheduleDrain(0);
    return "sent";
  }

  private async park(req: DeliveryRequest, why: string, notBefore = 0): Promise<Outcome> {
    if (!this.store) return this.drop(req, "no_store", why);
    const res = await this.store.put({ url: req.url, headers: req.headers, body: req.body, createdAt: this.clock.now(), notBefore, attempts: 0 });
    for (const bytes of res.evicted) this.countDrop("store_full", bytes, "evicted from the offline store to make room");
    if (res.id === null) return this.drop(req, "too_large", `${why}; larger than the offline store`);
    this.lastParkedId.set(req, res.id);
    this.stats.queued++;
    this.storeDirty = true;
    this.logger.log(`${req.label}: ${req.body.byteLength} B kept for later (${why})`);
    if (notBefore > 0) this.scheduleDrain(notBefore - this.clock.now());
    else if (!offline()) this.scheduleDrain(this.drainBackoff());
    return "queued";
  }

  private drop(req: DeliveryRequest, reason: DropReason, why: string): Outcome {
    this.countDrop(reason, req.body.byteLength, `${req.label}: ${why}`);
    return "dropped";
  }

  /** A record dropped before it reached the delivery layer (a full export queue). */
  countQueueDrop(label: string): void {
    this.countDrop("queue_full", 0, `${label}: export queue full`);
  }

  private countDrop(reason: DropReason, bytes: number, why: string): void {
    this.stats.dropped++;
    this.stats.droppedBytes += bytes;
    this.stats.dropReasons[reason] = (this.stats.dropReasons[reason] ?? 0) + 1;
    this.logger.warn(`delivery: dropped ${bytes} B (${reason}): ${why}`);
  }

  // ---- the store ----

  private drainBackoff(): number {
    return backoffDelay(this.drainFailures + 1, { baseDelayMs: 5000, maxDelayMs: 5 * 60_000 }, this.random);
  }

  private scheduleDrain(ms: number): void {
    if (!this.store || this.closed) return;
    if (this.drainTimer !== null) this.clock.clearTimeout(this.drainTimer);
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, Math.max(0, ms));
  }

  private async drainStore(): Promise<void> {
    const store = this.store!;
    for (;;) {
      if (this.closed || this.urgent() || offline()) return;
      const batch = await store.oldest(DRAIN_BATCH);
      if (batch.length === 0) {
        this.storeDirty = false;
        this.drainFailures = 0;
        return;
      }
      const now = this.clock.now();
      let progressed = false;
      let earliest = Infinity;
      for (const entry of batch) {
        if (this.closed || this.urgent()) return;
        const req: DeliveryRequest = { url: entry.url, headers: entry.headers, body: entry.body, label: labelOf(entry.url) };
        if (now - entry.createdAt > this.maxAgeMs) {
          await store.delete(entry.id!);
          this.drop(req, "expired", `stored ${Math.round((now - entry.createdAt) / 60_000)} min ago`);
          progressed = true;
          continue;
        }
        if (entry.notBefore > now) {
          earliest = Math.min(earliest, entry.notBefore);
          continue;
        }
        const res = await this.attempt(req, false);
        if (res.kind === "retry") {
          await this.retryLater(store, entry, res);
          return;
        }
        await store.delete(entry.id!);
        if (res.kind === "ok") this.stats.sent++;
        else this.drop(req, "rejected", res.why);
        progressed = true;
      }
      if (!progressed) {
        if (earliest !== Infinity) this.scheduleDrain(earliest - now);
        return;
      }
    }
  }

  private async retryLater(store: OfflineStore, entry: StoredRequest, res: Attempt & { kind: "retry" }): Promise<void> {
    this.drainFailures++;
    const delay = Math.max(res.retryAfterMs ?? 0, this.drainBackoff());
    await store.update({ ...entry, attempts: entry.attempts + 1, notBefore: this.clock.now() + delay });
    this.logger.log(`delivery: stored requests still failing (${res.why}), next try in ${delay} ms`);
    this.scheduleDrain(delay);
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    // One tab of the origin drains at a time; the others skip (whoever holds the lock sends it all).
    const run = locks?.request ? locks.request(DRAIN_LOCK, { ifAvailable: true }, (lock) => (lock ? fn() : undefined)) : fn();
    return Promise.resolve(run).then(
      () => undefined,
      (err: unknown) => this.logger.warn("delivery: sending the stored requests failed", err),
    );
  }

  // ---- plumbing ----

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.clock.clearTimeout(timer);
        this.waiting.delete(wake);
        resolve();
      };
      const timer = this.clock.setTimeout(wake, ms);
      this.waiting.add(wake);
    });
  }

  /** Ends every retry wait now: at page hide the request goes out on the unload path instead. */
  private wake(): void {
    for (const w of [...this.waiting]) w();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  private listen(target: EventTarget | undefined, type: string, fn: () => void): void {
    if (!target || typeof target.addEventListener !== "function") return;
    const safe = guard(fn);
    target.addEventListener(type, safe, { capture: true });
    this.unlisten.push(() => target.removeEventListener(type, safe, { capture: true }));
  }
}
