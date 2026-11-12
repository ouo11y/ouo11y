/**
 * The telemetry queue (SDK spec section 8): batches records, sends them, retries what the
 * collector could not take, and at page hide gets them out with `keepalive` or into the outbox.
 * One instance per signal (logs, traces); replay has its own queue so a replay backlog never
 * delays telemetry (TRN-3).
 *
 * - A flush every `flushIntervalMs`, or at once when `maxBatchRecords` are waiting (TRN-4).
 * - Bypass records (unhandled errors) travel in their own batches, so a full queue can evict
 *   ordinary records first, oldest first (TRN-11).
 * - A batch that must be retried keeps its serialized body (TRN-10) and has one owner: the
 *   outbox when it can be stored (its drainer retries it), else this queue's memory, until it is
 *   accepted, rejected, or evicted by the queue limit (TRN-9).
 * - While `gate()` says `hold` (consent pending) nothing is sent or stored (PRV-1).
 */
import { systemClock, type Clock, type TimerHandle } from "../core/clock";
import type { DropCounter } from "../core/drops";
import { attempt, quiet } from "../guard";
import type { DebugLogger } from "../logger";
import type { Http, PostResult } from "./http";
import { KEEPALIVE_MAX_BYTES } from "./keepalive";
import { retryDelay } from "./retry";
import type { Outbox, OutboxMeta } from "./store";

export interface QueueSettings {
  flushIntervalMs: number;
  maxBatchRecords: number;
  maxRequestBytes: number;
  maxQueueRecords: number;
  retryInitialMs: number;
  retryMaxMs: number;
}

export interface QueueOptions<T> {
  signal: "logs" | "traces";
  url: string;
  serialize(items: T[]): Uint8Array | undefined;
  /** Rejected record count in a 2xx response body. */
  rejected(body: Uint8Array): number;
  isBypass(item: T): boolean;
  nameOf(item: T): string;
  http: Http;
  /** Null while nothing may be stored (consent pending) or persistence is off. */
  outbox(): Outbox | null;
  /** A batch was handed to the outbox under this id: the drainer owns it from here. */
  onStored?(id: number): void;
  drops: DropCounter;
  settings: QueueSettings;
  logger: DebugLogger;
  /** `hold`: keep everything in memory (consent pending). */
  gate(): "open" | "hold";
  /** True while the page is hidden or unloading: requests must leave without awaiting anything. */
  hidden(): boolean;
  clock?: Clock;
  random?: () => number;
}

interface Batch {
  body: Uint8Array;
  records: number;
  bypass: boolean;
  /** Records per event or span name, for drop accounting. */
  names: Map<string, number>;
  failures: number;
  due: number;
}

export const JSON_CONTENT_TYPE = "application/json";

export class TelemetryQueue<T> {
  private queue: T[] = [];
  private retries: Batch[] = [];
  private inflight = 0;
  private timer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  /** The last answer was a failure: what is sent at page hide is also stored. */
  private failing = false;
  private readonly clock: Clock;
  readonly stats = { sent: 0 };

  constructor(private readonly o: QueueOptions<T>) {
    this.clock = o.clock ?? systemClock;
  }

  add(item: T): void {
    if (this.closed) return;
    const bypass = this.o.isBypass(item);
    while (this.size() >= this.o.settings.maxQueueRecords) {
      if (!this.evict(bypass)) {
        this.o.drops.add(this.o.nameOf(item), "queue_full");
        return;
      }
    }
    this.queue.push(item);
    if (this.o.gate() === "hold") return;
    if (this.queue.length >= this.o.settings.maxBatchRecords) void this.flush();
    else if (this.timer === null) this.timer = this.clock.setTimeout(() => void this.flush(), this.o.settings.flushIntervalMs);
  }

  /** Records waiting: queued, in flight and awaiting a retry. */
  size(): number {
    return this.queue.length + this.inflight + this.retries.reduce((n, b) => n + b.records, 0);
  }

  /** Sends everything queued now. Resolves when every request in flight is answered. Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.o.gate() === "hold") return Promise.resolve();
    const urgent = this.o.hidden();
    if (urgent) {
      // Nothing waits for a timer once the page is going away.
      for (const b of this.retries.splice(0)) this.dispatch(b, true);
    }
    const max = this.o.settings.maxBatchRecords;
    while (this.queue.length > 0) {
      const items = this.queue.splice(0, max);
      const bypass = items.filter((i) => this.o.isBypass(i));
      const rest = bypass.length > 0 ? items.filter((i) => !this.o.isBypass(i)) : items;
      // Errors first: they share the keepalive budget with everything else.
      for (const b of this.batches(bypass, true, urgent)) this.dispatch(b, urgent);
      for (const b of this.batches(rest, false, urgent)) this.dispatch(b, urgent);
    }
    return this.idle();
  }

  /** Resolves when no request is in flight. */
  idle(): Promise<void> {
    return Promise.all([...this.pending]).then(() => undefined);
  }

  /** Drops what is queued (consent denied or withdrawn). */
  discard(): void {
    this.queue = [];
    this.retries = [];
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
  }

  // ---- batching ----

  private batches(items: T[], bypass: boolean, urgent: boolean): Batch[] {
    if (items.length === 0) return [];
    const body = attempt(() => this.o.serialize(items));
    if (!body) {
      for (const i of items) this.o.drops.add(this.o.nameOf(i), "internal_error");
      return [];
    }
    const limit = urgent ? Math.min(KEEPALIVE_MAX_BYTES, this.o.settings.maxRequestBytes) : this.o.settings.maxRequestBytes;
    if (body.byteLength > limit && items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      return [...this.batches(items.slice(0, mid), bypass, urgent), ...this.batches(items.slice(mid), bypass, urgent)];
    }
    if (body.byteLength > this.o.settings.maxRequestBytes) {
      this.o.drops.add(this.o.nameOf(items[0]!), "too_large");
      return [];
    }
    const names = new Map<string, number>();
    for (const i of items) {
      const n = this.o.nameOf(i);
      names.set(n, (names.get(n) ?? 0) + 1);
    }
    return [{ body, records: items.length, bypass, names, failures: 0, due: 0 }];
  }

  private dispatch(batch: Batch, urgent: boolean): void {
    this.inflight += batch.records;
    const p = quiet(this.send(batch, urgent)).then(() => {
      this.inflight -= batch.records;
      this.pending.delete(p);
    });
    this.pending.add(p);
  }

  /** Hands the batch to the outbox. Resolves to its id there, or null when it could not be stored. */
  private async store(batch: Batch): Promise<number | null> {
    const outbox = this.o.outbox();
    if (!outbox) return null;
    try {
      const r = await outbox.put({ kind: batch.bypass ? "bypass" : "telemetry", signal: this.o.signal, body: batch.body, records: batch.records, createdAt: this.clock.now() });
      this.countEvicted(r.evicted);
      if (r.id !== null) this.o.onStored?.(r.id);
      return r.id;
    } catch {
      return null;
    }
  }

  private async send(batch: Batch, urgent: boolean): Promise<void> {
    const { http, url } = this.o;
    const post = { contentType: JSON_CONTENT_TYPE, rejected: this.o.rejected };
    if (!urgent) {
      await this.settle(batch, (await http.post(url, batch.body, { ...post, gzip: true }))!);
      return;
    }
    // Page hide: the request leaves with keepalive if the budget allows. A copy goes to the
    // outbox for a later page when the collector has been failing, the browser is offline or
    // the budget is spent; not otherwise, or every page close would send its last batch twice.
    const offline = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false;
    let stored = this.failing || offline ? this.store(batch) : null;
    let res = await http.post(url, batch.body, { ...post, mustKeepalive: true });
    if (res === null) {
      stored ??= this.store(batch);
      // A plain request, in case the page lives on.
      res = (await http.post(url, batch.body, post))!;
    }
    const id = stored ? await stored : null;
    if (res.kind === "retry" && id !== null) {
      // Not accepted and safely stored: the outbox owns it now.
      this.failing = true;
      return;
    }
    // Answered for good: the stored copy, if any, must not be sent again.
    if (id !== null) await this.o.outbox()?.delete(id);
    await this.settle(batch, res, id !== null);
  }

  /**
   * What an answer means for a batch. A batch the collector could not take has one owner: the
   * outbox when it could be stored (the drainer of this or a later page retries it, so it is
   * never sent by two parties), this queue's memory otherwise (TRN-9).
   */
  private async settle(batch: Batch, res: PostResult, storeTried = false): Promise<void> {
    this.failing = res.kind === "retry";
    if (res.kind === "ok") {
      this.stats.sent += batch.records;
      return;
    }
    if (res.kind === "partial") {
      this.stats.sent += batch.records - res.rejected;
      this.o.drops.add(this.o.signal, "partial_rejected", res.rejected);
      return;
    }
    if (res.kind === "reject") {
      this.o.logger.warn(`${this.o.signal}: rejected by the collector`, res.status);
      for (const [name, n] of batch.names) this.o.drops.add(name, "rejected_status", n);
      return;
    }
    if (this.closed) {
      for (const [name, n] of batch.names) this.o.drops.add(name, "queue_full", n);
      return;
    }
    if (batch.failures === 0 && !storeTried && (await this.store(batch)) !== null) return;
    batch.failures++;
    batch.due = this.clock.now() + retryDelay(batch.failures, res.retryAfterMs, this.o.settings.retryInitialMs, this.o.settings.retryMaxMs, this.o.random);
    this.retries.push(batch);
    this.armRetry();
  }

  private armRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.retries.length === 0 || this.closed) return;
    const due = Math.min(...this.retries.map((b) => b.due));
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      const now = this.clock.now();
      const ready = this.retries.filter((b) => b.due <= now);
      this.retries = this.retries.filter((b) => b.due > now);
      for (const b of ready) this.dispatch(b, this.o.hidden());
      this.armRetry();
    }, Math.max(1, due - this.clock.now()));
  }

  /** Makes room for one record: the oldest ordinary record goes first, bypass records last. */
  private evict(forBypass: boolean): boolean {
    const drop = (b: Batch): void => {
      this.retries.splice(this.retries.indexOf(b), 1);
      for (const [name, n] of b.names) this.o.drops.add(name, "queue_full", n);
    };
    const oldRetry = this.retries.find((b) => !b.bypass);
    if (oldRetry) {
      drop(oldRetry);
      return true;
    }
    const i = this.queue.findIndex((item) => !this.o.isBypass(item));
    if (i >= 0) {
      this.o.drops.add(this.o.nameOf(this.queue[i]!), "queue_full");
      this.queue.splice(i, 1);
      return true;
    }
    if (!forBypass) return false;
    if (this.retries[0]) {
      drop(this.retries[0]);
      return true;
    }
    if (this.queue.length > 0) {
      this.o.drops.add(this.o.nameOf(this.queue.shift()!), "queue_full");
      return true;
    }
    return false;
  }

  private countEvicted(evicted: OutboxMeta[]): void {
    for (const m of evicted) this.o.drops.add(m.signal === "replay" ? "ouo.replay.chunk" : m.signal, "storage_full", m.records);
  }
}

export interface DrainerOptions {
  /** Null while nothing may be stored. */
  outbox(): Outbox | null;
  http: Http;
  urls: { logs: string; traces: string };
  rejected: { logs(body: Uint8Array): number; traces(body: Uint8Array): number };
  drops: DropCounter;
  ttlMs: number;
  retryInitialMs: number;
  retryMaxMs: number;
  gate(): "open" | "hold";
  hidden(): boolean;
  clock?: Clock;
}

const DRAIN_LOCK = "ouo.outbox";
/**
 * Entries another page stored at its page hide are left alone this long: that page may still be
 * sending them. Entries this page handed over (`own`) are the drainer's from the start.
 */
export const DRAIN_GRACE_MS = 15_000;

/**
 * Sends the telemetry a previous page left in the outbox (TRN-12, TRN-13): one tab at a time
 * (Web Lock), oldest first, paced by the answers, never in one burst (GR-OFF-2).
 */
export class OutboxDrainer {
  private timer: TimerHandle | null = null;
  private failures = 0;
  private running: Promise<void> | null = null;
  private closed = false;
  private readonly owned = new Set<number>();
  private readonly clock: Clock;

  constructor(private readonly o: DrainerOptions) {
    this.clock = o.clock ?? systemClock;
  }

  schedule(ms: number): void {
    if (this.closed) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(0, ms));
  }

  /** A batch this page could not deliver is in the outbox under `id`: retry it from here. */
  own(id: number): void {
    if (this.owned.size >= 4096) this.owned.clear();
    this.owned.add(id);
    if (this.timer === null && !this.running) this.schedule(retryDelay(this.failures + 1, undefined, this.o.retryInitialMs, this.o.retryMaxMs));
  }

  drain(): Promise<void> {
    if (this.closed || this.o.gate() === "hold") return Promise.resolve();
    this.running ??= quiet(this.withLock(() => this.run())).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    const { http, drops } = this.o;
    const outbox = this.o.outbox();
    if (!outbox) return;
    const now = this.clock.now();
    const { entries, expired } = await outbox.list(now, this.o.ttlMs);
    for (const m of expired) drops.add(m.signal === "replay" ? "ouo.replay.chunk" : m.signal, "expired", m.records);
    let young = false;
    for (const m of entries) {
      if (m.kind === "replay") continue; // The replay engine drains its own, stream by stream.
      if (this.closed || this.o.hidden()) return;
      if (now - m.createdAt < DRAIN_GRACE_MS && !this.owned.has(m.id)) {
        young = true;
        continue;
      }
      const body = await outbox.body(m.id);
      if (!body) {
        await outbox.delete(m.id);
        drops.add(m.signal, "storage_error", m.records);
        continue;
      }
      const signal = m.signal === "traces" ? "traces" : "logs";
      const res = (await http.post(this.o.urls[signal], body, { contentType: JSON_CONTENT_TYPE, gzip: true, rejected: this.o.rejected[signal] }))!;
      if (res.kind === "retry") {
        this.failures++;
        this.schedule(retryDelay(this.failures, res.retryAfterMs, this.o.retryInitialMs, this.o.retryMaxMs));
        return;
      }
      this.failures = 0;
      this.owned.delete(m.id);
      await outbox.delete(m.id);
      if (res.kind === "partial") drops.add(signal, "partial_rejected", res.rejected);
      else if (res.kind === "reject") drops.add(signal, "rejected_status", m.records);
    }
    if (young) this.schedule(DRAIN_GRACE_MS);
  }

  private withLock(fn: () => Promise<void>): Promise<unknown> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
    if (!locks?.request) return fn();
    return locks.request(DRAIN_LOCK, { ifAvailable: true }, (lock) => (lock ? fn() : undefined));
  }
}
