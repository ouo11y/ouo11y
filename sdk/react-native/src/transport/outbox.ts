import type { DebugLogger } from "../logger";
import { systemClock, type Clock, type TimerHandle } from "../session/clock";
import { withTimeout } from "../session/storage";
import type { AsyncKeyValueStorage } from "../types";

export const OUTBOX_KEY = "ouo.outbox";
export const DEFAULT_OUTBOX_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_OUTBOX_MAX_ENTRIES = 500;
export const DEFAULT_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Retry waits double from 1 s up to this. */
export const MAX_RETRY_DELAY_MS = 30_000;
/** A stored index that cannot be read within this runs the process memory-only (`persistent` false). */
const LOAD_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol("timed out");

/** What the collector answered: an HTTP status, or 0 when the request did not reach it. */
export interface SendResult {
  status: number;
  /** `Retry-After` in milliseconds, when the answer had one. */
  retryAfterMs?: number;
}

export type Send = (url: string, body: string) => Promise<SendResult>;

interface Item {
  id: number;
  url: string;
  /** Body length in UTF-16 code units: bytes for OTLP JSON, which is ASCII but for user strings. */
  bytes: number;
  /** Queued at (epoch ms). */
  at: number;
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
  maxAgeMs?: number;
  clock?: Clock;
}

/** 2xx: sent. 408, 429, 5xx and no answer: try again later. Any other status: rejected, never retried. */
export function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * The OTLP requests of the SDK, persisted before they are sent (docs/specs/mobile-replay.md,
 * "Delivery"; checklist N49). Every batch is written to AsyncStorage first and removed when the
 * collector answers 2xx or rejects it, so an outage, a crash or a kill mid-request loses
 * nothing: what is left is sent oldest first on the next launch, on `drain` (foreground,
 * `flush`) and after a backoff. Bounded by bytes and entries, the oldest dropped first;
 * requests older than `maxAgeMs` are dropped unsent.
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
  private readonly maxAgeMs: number;
  private readonly clock: Clock;

  private index: Index = { next: 1, items: [] };
  /** Bodies queued by this process: sent from memory, so a failing storage only costs the next launch. */
  private readonly bodies = new Map<number, string>();
  private readonly loaded: Promise<void>;
  private draining: Promise<void> | null = null;
  private inFlight: number | null = null;
  private failures = 0;
  private retryTimer: TimerHandle | null = null;
  private stopped = false;
  /** False when the stored index could not be read: nothing is written or removed in storage. */
  private persistent = true;

  /** Counters for tests and the debug log. */
  readonly stats = { sent: 0, rejected: 0, dropped: 0 };

  constructor(opts: OutboxOptions) {
    this.storage = opts.storage;
    this.sendFn = opts.send;
    this.logger = opts.logger;
    this.maxBytes = opts.maxBytes ?? DEFAULT_OUTBOX_MAX_BYTES;
    this.maxEntries = opts.maxEntries ?? DEFAULT_OUTBOX_MAX_ENTRIES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_OUTBOX_MAX_AGE_MS;
    this.clock = opts.clock ?? systemClock;
    this.loaded = this.load();
  }

  /** Requests waiting, the one in flight included. */
  get size(): number {
    return this.index.items.length;
  }

  /** Persists the request, then sends it unless a retry is already scheduled. Never rejects. */
  async put(url: string, body: string): Promise<void> {
    await this.loaded;
    const item: Item = { id: this.index.next++, url, bytes: body.length, at: this.clock.now() };
    this.index.items.push(item);
    this.bodies.set(item.id, body);
    this.enforceBound();
    // Index first: a kill before the body is written leaves an entry the drain skips.
    this.persistIndex();
    if (this.persistent) await this.guard(this.storage.setItem(bodyKey(item.id), body));
    if (this.retryTimer === null) void this.drain();
  }

  /**
   * Sends what is waiting, oldest first, until it is all sent or a request fails (it stays,
   * and a retry is scheduled). One drain at a time; resolves when that drain stops.
   */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.run().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry();
  }

  // ---- internals ----

  private async run(): Promise<void> {
    await this.loaded;
    this.cancelRetry();
    while (!this.stopped) {
      const head = this.index.items[0];
      if (!head) {
        this.failures = 0;
        return;
      }
      if (this.clock.now() - head.at > this.maxAgeMs) {
        this.remove(head, "older than the offline store keeps");
        continue;
      }
      // In flight from here: a put's eviction must not drop it while its body is read or sent.
      this.inFlight = head.id;
      let res: SendResult;
      try {
        const body = this.bodies.get(head.id) ?? (await this.guard(this.storage.getItem(bodyKey(head.id)), null));
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
        this.stats.sent++;
        this.forget(head);
        this.failures = 0;
        continue;
      }
      if (!retryable(res.status)) {
        this.stats.rejected++;
        this.logger.warn(`delivery: ${head.url} rejected with HTTP ${res.status}, dropped`);
        this.forget(head);
        continue;
      }
      this.failures++;
      const delay = Math.max(res.retryAfterMs ?? 0, Math.min(1000 * 2 ** (this.failures - 1), MAX_RETRY_DELAY_MS));
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
      raw = await withTimeout<string | null | typeof TIMED_OUT>(this.storage.getItem(OUTBOX_KEY), LOAD_TIMEOUT_MS, TIMED_OUT);
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
        if (parsed.items.length > 0) this.logger.log(`delivery: ${parsed.items.length} request(s) left by an earlier run`);
      }
    } catch {
      this.logger.warn("delivery: unreadable outbox index, starting empty");
    }
  }

  private enforceBound(): void {
    let bytes = this.index.items.reduce((n, i) => n + i.bytes, 0);
    // Oldest first; never the newest, nor the one in flight (its answer removes it).
    for (const victim of this.index.items.slice(0, -1)) {
      if (bytes <= this.maxBytes && this.index.items.length <= this.maxEntries) break;
      if (victim.id === this.inFlight) continue;
      bytes -= victim.bytes;
      this.remove(victim, "offline store full");
    }
  }

  private remove(item: Item, why: string): void {
    this.stats.dropped++;
    this.logger.warn(`delivery: dropped ${item.bytes} B for ${item.url} (${why})`);
    this.forget(item);
  }

  /** Body first, then the index: a kill in between leaves no unreferenced body. */
  private forget(item: Item): void {
    this.index.items = this.index.items.filter((i) => i.id !== item.id);
    this.bodies.delete(item.id);
    if (this.persistent) void this.guard(this.storage.removeItem(bodyKey(item.id)));
    this.persistIndex();
  }

  private persistIndex(): void {
    if (!this.persistent) return;
    void this.guard(this.storage.setItem(OUTBOX_KEY, JSON.stringify(this.index)));
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async guard<T>(p: Promise<T>, fallback?: T): Promise<T> {
    try {
      return await p;
    } catch (err) {
      this.logger.warn("delivery: storage error", err);
      return fallback as T;
    }
  }
}

function bodyKey(id: number): string {
  return `${OUTBOX_KEY}.${id}`;
}
