/**
 * Sessions (SDK spec section 5). A session is a time-boxed id for one period of user presence,
 * shared by every same-origin tab through one `localStorage` record.
 *
 * - It starts on activity (SES-3, SES-5), never because a record needs an id: a polling tab makes
 *   no session (SES-10).
 * - It ends after `inactivityTimeoutMs` without activity, at `maxDurationMs`, on `restart`, on
 *   `end` (shutdown, consent). Reaching the maximum with the user present rolls at once (SES-9).
 * - Each `session.start` and `session.end` is emitted by exactly one tab (SES-11): the id is
 *   chosen synchronously by write, re-read and adopt, and the emission is confirmed under a Web
 *   Lock where the browser has one, guarded by the `a` (announced) and `e` (ended) marks in the
 *   record. Records created while that confirmation is pending are held, so `session.start` is the
 *   session's first record (SES-4).
 * - Sampling is decided once from the id and stored with the session (SMP-1, SMP-2).
 */
import { systemClock, type Clock, type TimerHandle } from "../core/clock";
import { isSessionId, newSessionId, sampledAt } from "../core/ids";
import { attempt, point } from "../guard";
import type { KeyValueStorage } from "./storage";

export const SESSION_KEY = "ouo.session";
const LOCK_NAME = "ouo.session";
/** Last activity is written at most this often (SES-6). */
export const PERSIST_EVERY_MS = 5000;
/** How long a transition waits for the Web Lock before going ahead without it. */
const LOCK_WAIT_MS = 300;

export type EndReason = "timeout" | "max_duration" | "manual" | "shutdown" | "consent";

/** The stored record. Short keys: it is rewritten every few seconds. Version 1 (GR-UPG-1). */
export interface SessionRecord {
  v: 1;
  id: string;
  /** Start and last activity, epoch ms. */
  start: number;
  last: number;
  /** The session before this one. */
  prev?: string;
  /** The session rate when it was decided, and the decision. */
  rate: number;
  s: boolean;
  /** `session.start` was emitted. */
  a?: 1;
  /** `session.end` was emitted. */
  e?: 1;
  /** `enduser.id`, set by the app. */
  u?: string;
}

export interface Stamp {
  id: string;
  sampled: boolean;
  /** No valid session: `id` is the last one known, or one made up for this page. */
  expired: boolean;
  user: string | undefined;
}

export interface SessionHooks {
  /** Emit `session.start` for `rec` (the listener skips unsampled sessions). */
  onStart(rec: SessionRecord): void;
  /** Emit `session.end` for `rec`, timestamped at its last activity. */
  onEnd(rec: SessionRecord, reason: EndReason): void;
  /** The current session of this tab changed: started here, adopted from another tab, or none. */
  onChange(rec: SessionRecord | null): void;
  /** Hold and release the records created while a start is being confirmed. */
  hold(): void;
  release(): void;
  /** Records stamped with `from` (a start this tab lost to another) belong to `to`. */
  restamp(from: string, to: string): void;
}

export interface SessionOptions {
  storage: KeyValueStorage;
  inactivityTimeoutMs: number;
  maxDurationMs: number;
  sessionRate: number;
  hooks: SessionHooks;
  clock?: Clock;
  /** Injectable for tests; default `navigator.locks`. null disables locking. */
  locks?: Pick<LockManager, "request"> | null;
}

function parse(raw: string | null): SessionRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<SessionRecord> | null;
    if (!r || r.v !== 1 || !isSessionId(r.id) || typeof r.start !== "number" || typeof r.last !== "number" || typeof r.s !== "boolean") return null;
    return r as SessionRecord;
  } catch {
    // Corrupt or written by another version: discarded, never a crash.
    return null;
  }
}

export class SessionManager {
  private rec: SessionRecord | null = null;
  private live = false;
  private lastKnown: string | undefined;
  private orphan: string | undefined;
  private user: string | undefined;
  private persistedAt = 0;
  private timer: TimerHandle | null = null;
  private stopped = false;
  /** The next session must not name a previous one (consent was withdrawn, PRV-4). */
  private severed = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly clock: Clock;
  private readonly locks: Pick<LockManager, "request"> | null;

  constructor(private readonly opts: SessionOptions) {
    this.clock = opts.clock ?? systemClock;
    this.locks = opts.locks !== undefined ? opts.locks : ((globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks ?? null);
  }

  /** Reads what the browser already holds. `visible`: `init` in a visible page counts as activity. */
  start(visible: boolean): void {
    const stored = this.read();
    if (stored) {
      this.rec = stored;
      this.lastKnown = stored.id;
      this.user = stored.u;
      this.live = !stored.e && this.valid(stored, this.clock.now());
      if (this.live) {
        this.arm();
        this.opts.hooks.onChange(stored);
      }
    }
    if (visible) this.activity();
  }

  /** A signal of user presence (SES-5). Starts, extends or rolls the session. */
  activity(): void {
    if (this.stopped) return;
    point("session.activity");
    const now = this.clock.now();
    if (this.live && this.rec && this.valid(this.rec, now)) {
      this.touch(now);
      return;
    }
    const stored = this.read();
    if (stored && !stored.e && this.valid(stored, now)) {
      // Another tab kept it alive, or started the next one.
      if (stored.id === this.rec?.id) {
        this.rec = stored;
        this.live = true;
      } else this.adopt(stored);
      this.touch(now);
      return;
    }
    this.begin(now, stored ?? this.rec);
  }

  /** `restartSession()`: ends the current session and starts the next one now. */
  restart(): void {
    if (this.stopped) return;
    this.begin(this.clock.now(), this.read() ?? this.rec, "manual");
  }

  /** Ends the current session without starting another (shutdown, consent withdrawal). */
  end(reason: EndReason): void {
    this.finish(reason);
  }

  /**
   * Ends the session in this very task, without waiting for the session lock (consent
   * withdrawal: the end must be announced before anything else changes). The `e` mark in the
   * stored record still keeps a second tab from announcing it again.
   */
  endNow(reason: EndReason): void {
    this.finish(reason, true);
  }

  /** Forget the stored session; the next one has no `session.previous_id` (PRV-4). */
  sever(): void {
    this.live = false;
    this.rec = null;
    this.lastKnown = undefined;
    this.severed = true;
    this.disarm();
    attempt(() => this.opts.storage.remove(SESSION_KEY));
  }

  /** `enduser.id` for later records. A different identified user starts a new session. */
  setUser(id: string | null): void {
    if (id === null) {
      this.user = undefined;
      if (this.rec) {
        delete this.rec.u;
        if (this.live) this.save(this.rec);
      }
      return;
    }
    const before = this.live ? this.rec?.u : undefined;
    this.user = id;
    if (before !== undefined && before !== id) {
      this.restart();
      return;
    }
    if (this.live && this.rec) {
      this.rec.u = id;
      this.save(this.rec);
    }
  }

  /** The session a record created now belongs to. */
  stamp(): Stamp {
    const rec = this.rec;
    if (this.live && rec) {
      const now = this.clock.now();
      if (this.valid(rec, now)) return { id: rec.id, sampled: rec.s, expired: false, user: rec.u };
      const stored = this.read();
      if (stored && stored.id === rec.id && !stored.e && this.valid(stored, now)) {
        rec.last = stored.last;
        return { id: rec.id, sampled: rec.s, expired: false, user: rec.u };
      }
      this.finish(now - rec.start >= this.opts.maxDurationMs ? "max_duration" : "timeout");
    }
    return { id: this.lastKnown ?? (this.orphan ??= newSessionId()), sampled: false, expired: true, user: this.user };
  }

  /** Current session id, or undefined when there is no valid session. */
  id(): string | undefined {
    const s = this.stamp();
    return s.expired ? undefined : s.id;
  }

  current(): SessionRecord | null {
    return this.live && this.rec && this.valid(this.rec, this.clock.now()) ? this.rec : null;
  }

  /** A `storage` event for the session key: another tab started, extended or ended the session. */
  handleStorage(raw: string | null): void {
    if (this.stopped) return;
    const other = parse(raw);
    if (!other) {
      // Cleared elsewhere (consent withdrawn in another tab).
      if (raw === null && this.live) {
        this.live = false;
        this.disarm();
        this.opts.hooks.onChange(null);
      }
      return;
    }
    const now = this.clock.now();
    if (other.id === this.rec?.id) {
      this.rec.last = Math.max(this.rec.last, other.last);
      if (other.a) this.rec.a = 1;
      // Also when it was cleared: a logout in one tab is a logout in all.
      this.user = other.u;
      if (other.u === undefined) delete this.rec.u;
      else this.rec.u = other.u;
      if (other.e && this.live) {
        this.rec.e = 1;
        this.live = false;
        this.disarm();
        this.opts.hooks.onChange(null);
      }
    } else if (!other.e && this.valid(other, now)) this.adopt(other);
  }

  /** Writes the last activity now (page hide), so the next page sees it. */
  persist(): void {
    if (this.live && this.rec) this.saveActivity(this.clock.now());
  }

  /** Resolves when every pending start and end has been announced. */
  settled(): Promise<void> {
    return this.pending;
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  // ---- transitions ----

  private begin(now: number, previous: SessionRecord | null, reason?: EndReason): void {
    const id = newSessionId();
    const next: SessionRecord = { v: 1, id, start: now, last: now, rate: this.opts.sessionRate, s: sampledAt(id, this.opts.sessionRate, 0) };
    if (previous && !this.severed) next.prev = previous.id;
    if (this.user !== undefined) next.u = this.user;
    this.write(next);
    // Write, re-read, adopt: without locks this alone decides between tabs that start together.
    const back = this.read();
    if (back && back.id !== id && !back.e && this.valid(back, now)) {
      this.adopt(back);
      return;
    }
    this.rec = next;
    this.live = true;
    this.lastKnown = id;
    this.severed = false;
    this.persistedAt = now;
    this.arm();
    const ending = previous && !previous.e ? { rec: previous, reason: reason ?? (now - previous.start >= this.opts.maxDurationMs ? "max_duration" : "timeout") } : undefined;
    this.opts.hooks.hold();
    this.locked(() => {
      const cur = this.read();
      if (cur && cur.id !== id && !cur.e && this.valid(cur, this.clock.now())) {
        // Another tab won under the lock: what was stamped with our id belongs to its session.
        this.adopt(cur);
        this.opts.hooks.restamp(id, cur.id);
        return;
      }
      if (ending) this.opts.hooks.onEnd(ending.rec, ending.reason);
      if (!cur?.a) {
        next.a = 1;
        if (this.rec === next) this.write(next);
        this.opts.hooks.onStart(next);
      }
      this.opts.hooks.onChange(next);
    }, () => this.opts.hooks.release());
  }

  private finish(reason: EndReason, now = false): void {
    const rec = this.rec;
    if (!rec || !this.live) return;
    this.live = false;
    this.disarm();
    const run = (): void => {
      const cur = this.read();
      if (cur && cur.id === rec.id) {
        if (!cur.e) {
          cur.e = 1;
          cur.last = Math.max(cur.last, rec.last);
          this.write(cur);
          this.opts.hooks.onEnd(cur, reason);
        }
      }
      // No stored record (storage was cleared from outside): no tab can know it is the one to
      // announce the end, so none does. Consumers treat `session.end` as a hint (SES-8).
      rec.e = 1;
      this.opts.hooks.onChange(null);
    };
    if (now) attempt(run);
    else this.locked(run);
  }

  private adopt(other: SessionRecord): void {
    this.rec = other;
    this.live = true;
    this.lastKnown = other.id;
    this.user = other.u ?? this.user;
    this.arm();
    this.opts.hooks.onChange(other);
  }

  /** Runs `fn` under the session lock when there is one, otherwise now. `after` always runs once. */
  private locked(fn: () => void, after?: () => void): void {
    let ran = false;
    const run = (): void => {
      if (ran) return;
      ran = true;
      try {
        attempt(fn);
      } finally {
        if (after) attempt(after);
      }
    };
    const locks = this.locks;
    if (!locks) {
      run();
      return;
    }
    let request: Promise<unknown>;
    try {
      const abort = typeof AbortController === "function" ? new AbortController() : null;
      const giveUp = abort ? this.clock.setTimeout(() => abort.abort(), LOCK_WAIT_MS) : null;
      request = Promise.resolve(locks.request(LOCK_NAME, abort ? { signal: abort.signal } : {}, run)).finally(() => {
        if (giveUp !== null) this.clock.clearTimeout(giveUp);
      });
    } catch {
      request = Promise.resolve();
    }
    // Lock refused, aborted or broken: go ahead without it (write, re-read and adopt already ran).
    this.pending = Promise.all([this.pending, request.then(run, run)]).then(() => undefined);
  }

  // ---- activity and expiry ----

  private valid(rec: SessionRecord, now: number): boolean {
    return now - rec.last < this.opts.inactivityTimeoutMs && now - rec.start < this.opts.maxDurationMs;
  }

  private touch(now: number): void {
    const rec = this.rec!;
    if (now > rec.last) rec.last = now;
    if (now - this.persistedAt >= PERSIST_EVERY_MS) this.saveActivity(now);
  }

  private saveActivity(now: number): void {
    const rec = this.rec!;
    this.persistedAt = now;
    const cur = this.read();
    if (!cur || cur.id === rec.id) {
      if (cur?.e) {
        // Ended by another tab an instant ago: this activity starts the next session.
        this.live = false;
        this.begin(now, cur);
        return;
      }
      this.write({ ...rec, ...(cur?.a ? { a: 1 as const } : {}), last: Math.max(rec.last, cur?.last ?? 0) });
    } else if (!cur.e && this.valid(cur, now)) this.adopt(cur);
  }

  private arm(): void {
    this.disarm();
    const rec = this.rec;
    if (!rec || this.stopped) return;
    const due = Math.min(rec.last + this.opts.inactivityTimeoutMs, rec.start + this.opts.maxDurationMs) - this.clock.now();
    // One timer, re-armed only when it fires: activity does not touch it. The margin lets a tab
    // that was active within the last write interval get its activity into storage first.
    this.timer = this.clock.setTimeout(() => this.check(), Math.max(0, due) + PERSIST_EVERY_MS + 250);
  }

  private disarm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private check(): void {
    this.timer = null;
    const rec = this.rec;
    if (!rec || !this.live || this.stopped) return;
    const now = this.clock.now();
    const stored = this.read();
    if (stored && stored.id === rec.id) rec.last = Math.max(rec.last, stored.last);
    if (this.valid(rec, now)) {
      this.arm();
      return;
    }
    this.finish(now - rec.start >= this.opts.maxDurationMs ? "max_duration" : "timeout");
  }

  // ---- storage ----

  private read(): SessionRecord | null {
    return attempt(() => parse(this.opts.storage.get(SESSION_KEY)), null);
  }

  private write(rec: SessionRecord): void {
    attempt(() => this.opts.storage.set(SESSION_KEY, JSON.stringify(rec)));
  }

  private save(rec: SessionRecord): void {
    const cur = this.read();
    if (!cur || cur.id === rec.id) this.write({ ...rec, ...(cur?.a ? { a: 1 as const } : {}), ...(cur?.e ? { e: 1 as const } : {}) });
  }
}
