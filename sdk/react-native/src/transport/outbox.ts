import type { DropCounter, DropReason } from "../drops";
import { guard } from "../guard";
import type { DebugLogger } from "../logger";
import { systemClock, type Clock, type TimerHandle } from "../session/clock";
import { withTimeout } from "../session/storage";
import type { AsyncKeyValueStorage } from "../types";

export const OUTBOX_KEY = "ouo.outbox";
export const DEFAULT_OUTBOX_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_OUTBOX_MAX_ENTRIES = 500;
/** Retry waits (spec TRN-7): exponential from the first to the last, with full jitter. */
export const RETRY_INITIAL_MS = 1000;
export const RETRY_MAX_MS = 300_000;
/** A stored index that cannot be read within this runs the process memory-only (`persistent` false). */
const LOAD_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol("timed out");

/** What the collector answered: an HTTP status, or 0 when the request did not reach it. */
export interface SendResult {
  status: number;
  /** `Retry-After` in milliseconds, when the answer had one. */
  retryAfterMs?: number;
  /** Records a 2xx answer rejected (`partial_success` in its body), when it said so. */
  rejected?: number;
}

export type Send = (url: string, body: string) => Promise<SendResult>;

interface Item {
  id: number;
  url: string;
  /** Body length in UTF-16 code units: bytes for OTLP JSON, which is ASCII but for user strings. */
  bytes: number;
  /** Records in the request, for the drop count (absent in an index written by an older SDK: counted as 1). */
  n?: number;
  /** The request holds a bypass-set record (an unhandled exception, a crash): evicted last (TRN-14). */
  keep?: boolean;
}

interface Index {
  next: number;
  items: Item[];
}

export interface OutboxOptions {
  /** Not wrapped in `safeStorage`: a failed read must be told apart from an empty store. */
  storage: AsyncKeyValueStorage;
  send: Send;
  logger: DebugLogger;
  maxBytes?: number;
  maxEntries?: number;
  clock?: Clock;
  /** Counts the records of every request dropped here (spec ERR-7). */
  drops?: DropCounter;
  /** Jitter source, 0 to 1 (tests pass a constant). Default `Math.random`. */
  random?: () => number;
}

/**
 * Spec 8.2 (TRN-6): 429 and 503 are retried honouring `Retry-After`; 502, 504 and no answer (0)
 * are retried with backoff. Any other status is final: the request is dropped and counted as
 * `rejected_status`, so a request the collector answers 500 to every time costs one attempt
 * instead of blocking the queue (checklist N55). A 2xx that rejected some records
 * (`partial_success`) is not retried either: deleted, and the rejected records counted.
 */
export function retryable(status: number): boolean {
  return status === 0 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * The OTLP requests of the SDK, persisted before they are sent (docs/specs/mobile-replay.md,
 * "Delivery"; checklist N49). Every batch is written to AsyncStorage first and removed when the
 * collector answers 2xx or rejects it, so an outage, a crash or a kill mid-request loses
 * nothing: what is left is sent oldest first on the next launch, on `drain` (foreground,
 * `flush`) and after a backoff. Bounded by bytes and entries, the oldest dropped first.
 *
 * No age bound: the wall clock is the user's to move, and an age on it dropped everything queued
 * when the clock moved a day forward (checklist N77 on iOS, N83 here); the bounds cap the storage
 * and the backend decides what is too old to ingest. The order is the order of `put` (the index
 * array), whatever the clock does.
 *
 * Layout: `ouo.outbox` holds the index (`{ next, items }`), each body is under `ouo.outbox.<id>`.
 * The index is written before a body and after a body is removed, so a kill in between leaves
 * an index entry without a body (skipped) rather than a body nobody references. When the stored
 * index cannot be read (an error, or no answer within 5 s), this process keeps its requests in
 * memory only and writes nothing, so the stored queue is left for the next launch intact.
 *
 * Delivery is at least once: a request that arrived just before a kill is sent again. Tempo and
 * Loki tolerate the duplicate (same span id, same log line).
 */
export class Outbox {
  private readonly storage: AsyncKeyValueStorage;
  private readonly sendFn: Send;
  private readonly logger: DebugLogger;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private readonly drops: DropCounter | undefined;
  private readonly random: () => number;

  private index: Index = { next: 1, items: [] };
  /** Bodies queued by this process: sent from memory, so a failing storage only costs the next launch. */
  private readonly bodies = new Map<number, string>();
  private readonly loaded: Promise<void>;
  private draining: Promise<void> | null = null;
  private inFlight: number | null = null;
  private failures = 0;
  private retryTimer: TimerHandle | null = null;
  private stopped = false;
  /** Consent pending or withdrawn: requests are kept in memory only, none is sent and nothing is written. */
  private held = false;
  /** Requests an earlier run stored that were dropped while held: their bodies are removed on `release`. */
  private orphans: number[] = [];
  /** Ids below this were stored by an earlier run. */
  private storedBelow = 0;
  /** Ids whose body this process wrote to storage. */
  private readonly stored = new Set<number>();
  /** False when the stored index could not be read: nothing is written or removed in storage. */
  private persistent = true;

  /**
   * Counters for tests and the debug log: `rejected`, dropped for a final answer (any status but
   * 2xx and the retryable ones); `dropped`, for the bounds or a body missing in storage.
   */
  readonly stats = { sent: 0, rejected: 0, dropped: 0 };

  constructor(opts: OutboxOptions) {
    this.storage = opts.storage;
    this.sendFn = opts.send;
    this.logger = opts.logger;
    this.maxBytes = opts.maxBytes ?? DEFAULT_OUTBOX_MAX_BYTES;
    this.maxEntries = opts.maxEntries ?? DEFAULT_OUTBOX_MAX_ENTRIES;
    this.clock = opts.clock ?? systemClock;
    this.drops = opts.drops;
    this.random = opts.random ?? Math.random;
    this.loaded = this.load();
  }

  /** Requests waiting, the one in flight included. */
  get size(): number {
    return this.index.items.length;
  }

  /** Persists the request, then sends it unless a retry is already scheduled. Never rejects. */
  put(url: string, body: string, records = 1, bypass = false): Promise<void> {
    return guard.run("outbox.put", () => this.doPut(url, body, records, bypass), Promise.resolve());
  }

  private async doPut(url: string, body: string, records: number, bypass: boolean): Promise<void> {
    await this.loaded;
    const item: Item = { id: this.index.next++, url, bytes: body.length, n: records, ...(bypass ? { keep: true } : {}) };
    this.index.items.push(item);
    this.bodies.set(item.id, body);
    this.enforceBound();
    // Index first: a kill before the body is written leaves an entry the drain skips.
    this.persistIndex();
    if (this.writable) {
      this.stored.add(item.id);
      await this.guard(() => this.storage.setItem(bodyKey(item.id), body));
    }
    // Memory only (spec TRN-15): the request is still sent, but a kill now loses it. Counted.
    else if (!this.persistent) this.count(item, "persistence_failed");
    if (this.retryTimer === null && !this.held) void this.drain();
  }

  /**
   * Sends what is waiting, oldest first, until it is all sent or a request fails (it stays,
   * and a retry is scheduled). One drain at a time; resolves when that drain stops.
   */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    // Cleared by the run itself, in the same turn it ends: a `put` right after must start a new drain.
    const draining = guard.run("outbox.drain", () =>
      this.run().finally(() => {
        this.draining = null;
      }),
    );
    if (!draining) return Promise.resolve();
    this.draining = draining;
    return draining;
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry();
  }

  /** Whether this outbox writes to storage: the stored index was readable, and consent is not held. */
  private get writable(): boolean {
    return this.persistent && !this.held;
  }

  /**
   * Consent pending or withdrawn (spec PRV-1): nothing is sent and nothing is written. Requests
   * wait in memory, within the bounds.
   */
  hold(): void {
    this.held = true;
    this.cancelRetry();
  }

  /** Consent granted: what waited in memory is written out, then sending goes on (`drain`). */
  async release(): Promise<void> {
    await this.loaded;
    if (!this.held) return;
    this.held = false;
    if (!this.persistent) return;
    for (const id of this.orphans.splice(0)) await this.guard(() => this.storage.removeItem(bodyKey(id)));
    this.persistIndex();
    for (const item of this.index.items.slice()) {
      const body = this.bodies.get(item.id);
      // Held again meanwhile (consent withdrawn): the rest stays in memory.
      if (this.held) return;
      if (body === undefined || item.id < this.storedBelow || this.stored.has(item.id)) continue;
      this.stored.add(item.id);
      await this.guard(() => this.storage.setItem(bodyKey(item.id), body));
    }
  }

  /** The storage keys this outbox may have written: the index and one per stored request. */
  keys(): string[] {
    return [OUTBOX_KEY, ...this.index.items.map((i) => bodyKey(i.id)), ...this.orphans.map(bodyKey)];
  }

  /**
   * Consent withdrawn (PRV-4): forgets every waiting request. Not counted as drops (spec
   * TRN-13). The caller takes `keys()` first and deletes them from the persistent storage.
   */
  async clear(): Promise<void> {
    await this.loaded;
    this.cancelRetry();
    this.failures = 0;
    this.index.items = [];
    this.bodies.clear();
    this.orphans = [];
    this.stored.clear();
  }

  // ---- internals ----

  private async run(): Promise<void> {
    await this.loaded;
    if (this.held) return;
    this.cancelRetry();
    while (!this.stopped && !this.held) {
      const head = this.index.items[0];
      if (!head) {
        this.failures = 0;
        return;
      }
      // In flight from here: a put's eviction must not drop it while its body is read or sent.
      this.inFlight = head.id;
      let res: SendResult;
      try {
        const body = this.bodies.get(head.id) ?? (await this.guard(() => this.storage.getItem(bodyKey(head.id)), null));
        if (body === null) {
          this.inFlight = null;
          this.remove(head, "body missing (killed while it was written)");
          continue;
        }
        res = await this.sendFn(head.url, body);
      } catch {
        res = { status: 0 };
      } finally {
        this.inFlight = null;
      }
      if (res.status >= 200 && res.status < 300) {
        // Accepted; what `partial_success` rejected is not retried (spec 8.2), only counted.
        if (typeof res.rejected === "number" && res.rejected > 0) {
          this.drops?.count(signalOf(head.url), "partial_rejected", res.rejected);
          this.logger.warn(`delivery: ${head.url} accepted, ${res.rejected} record(s) rejected by the collector`);
        }
        this.stats.sent++;
        this.forget(head);
        this.failures = 0;
        continue;
      }
      if (!retryable(res.status)) {
        this.stats.rejected++;
        this.count(head, "rejected_status");
        this.logger.warn(`delivery: ${head.url} rejected with HTTP ${res.status}, dropped (not retryable)`);
        this.forget(head);
        continue;
      }
      this.failures++;
      // TRN-7: full jitter over an exponential ceiling. TRN-8: `Retry-After` wins, capped at the maximum.
      const ceiling = Math.min(RETRY_INITIAL_MS * 2 ** Math.min(this.failures - 1, 30), RETRY_MAX_MS);
      const delay = res.retryAfterMs !== undefined ? Math.min(res.retryAfterMs, RETRY_MAX_MS) : Math.round(this.random() * ceiling);
      this.logger.log(`delivery: ${res.status === 0 ? "network error" : `HTTP ${res.status}`}, ${this.index.items.length} request(s) kept, retry in ${delay} ms`);
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = null;
        void this.drain();
      }, delay);
      return;
    }
  }

  private async load(): Promise<void> {
    let raw: string | null | typeof TIMED_OUT;
    try {
      raw = await withTimeout<string | null | typeof TIMED_OUT>(Promise.resolve().then(() => this.storage.getItem(OUTBOX_KEY)), LOAD_TIMEOUT_MS, TIMED_OUT);
    } catch {
      raw = TIMED_OUT;
    }
    if (raw === TIMED_OUT) {
      this.persistent = false;
      this.logger.warn("delivery: stored requests unreadable; this run keeps its requests in memory and leaves them for the next launch");
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Index;
      if (parsed && Array.isArray(parsed.items) && typeof parsed.next === "number") {
        this.index = parsed;
        this.storedBelow = parsed.next;
        if (parsed.items.length > 0) this.logger.log(`delivery: ${parsed.items.length} request(s) left by an earlier run`);
      }
    } catch {
      this.logger.warn("delivery: unreadable outbox index, starting empty");
    }
  }

  private enforceBound(): void {
    let bytes = this.index.items.reduce((n, i) => n + i.bytes, 0);
    // Oldest first, ordinary telemetry before requests that hold a bypass-set record (TRN-11,
    // TRN-14); never the newest, nor the one in flight (its answer removes it).
    const candidates = this.index.items.slice(0, -1);
    for (const victim of [...candidates.filter((i) => !i.keep), ...candidates.filter((i) => i.keep)]) {
      if (bytes <= this.maxBytes && this.index.items.length <= this.maxEntries) break;
      if (victim.id === this.inFlight) continue;
      bytes -= victim.bytes;
      this.remove(victim, "offline store full");
    }
  }

  private count(item: Item, reason: DropReason): void {
    this.drops?.count(signalOf(item.url), reason, item.n ?? 1);
  }

  private remove(item: Item, why: string): void {
    this.stats.dropped++;
    this.count(item, "outbox_evicted");
    this.logger.warn(`delivery: dropped ${item.bytes} B for ${item.url} (${why})`);
    this.forget(item);
  }

  /** Body first, then the index: a kill in between leaves no unreferenced body. */
  private forget(item: Item): void {
    this.index.items = this.index.items.filter((i) => i.id !== item.id);
    this.bodies.delete(item.id);
    const inStorage = item.id < this.storedBelow || this.stored.delete(item.id);
    if (this.writable) void this.guard(() => this.storage.removeItem(bodyKey(item.id)));
    // Held: its body cannot be removed now; `release` or the caller of `keys()` does it.
    else if (this.held && inStorage) this.orphans.push(item.id);
    this.persistIndex();
  }

  private persistIndex(): void {
    if (!this.writable) return;
    void this.guard(() => this.storage.setItem(OUTBOX_KEY, JSON.stringify(this.index)));
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A storage call that throws or rejects is the environment's failure: logged, not an SDK error. */
  private async guard<T>(call: () => Promise<T>, fallback?: T): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.logger.warn("delivery: storage error", err);
      return fallback as T;
    }
  }
}

function signalOf(url: string): "span" | "log" {
  return /\/v1\/traces(?:[?#]|$)/.test(url) ? "span" : "log";
}

function bodyKey(id: number): string {
  return `${OUTBOX_KEY}.${id}`;
}
