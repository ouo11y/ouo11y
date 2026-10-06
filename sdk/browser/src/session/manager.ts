import type { Attrs } from "../types";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { uuidv4 } from "./ids";
import type { KeyValueStorage } from "./storage";
import type { DebugLogger } from "../logger";

export const SESSION_STORAGE_KEY = "ouo.session";
export const USER_STORAGE_KEY = "ouo.user";
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
/** Activity is persisted at most once per second (spec: activity rules). */
const PERSIST_THROTTLE_MS = 1000;

export type EndReason = "inactivity" | "max_duration";

/** What is persisted under `ouo.session`. Timestamps are Unix epoch milliseconds. */
export interface SessionRecord {
  id: string;
  startedAt: number;
  lastActivity: number;
  previousId?: string;
  /** Next replay chunk sequence number; reloads continue the sequence. */
  replaySeq: number;
  /** Replay sampling decision, taken once per session. */
  replaySampled?: boolean;
  endedAt?: number;
  endReason?: EndReason;
}

interface UserRecord {
  id: string;
  anonymous: boolean;
}

export interface SessionEvent {
  name: "session.start" | "session.end";
  attributes: Attrs;
}

export interface SessionManagerOptions {
  storage: KeyValueStorage;
  clock?: Clock;
  inactivityTimeoutMs?: number;
  maxDurationMs?: number;
  /** Receives `session.start` / `session.end`; the caller turns them into OTel log records. */
  onEvent: (event: SessionEvent) => void;
  /** Called whenever the active session id changes (new session created here or adopted from another tab). */
  onRotate?: (next: SessionRecord, previousId: string | undefined) => void;
  initialUserId?: string;
  logger?: DebugLogger;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as T;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Session state machine for the web (docs/specs/session-lifecycle.md).
 * Pure: everything time or storage related is injected.
 */
export class SessionManager {
  private readonly storage: KeyValueStorage;
  private readonly clock: Clock;
  private readonly inactivityTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly onEvent: (event: SessionEvent) => void;
  private readonly onRotate: ((next: SessionRecord, previousId: string | undefined) => void) | undefined;
  private readonly logger: DebugLogger | undefined;

  private current: SessionRecord | null = null;
  private lastEnded: SessionRecord | null = null;
  private user: UserRecord;
  private lastPersist = 0;
  private timer: unknown = null;
  private started = false;

  constructor(options: SessionManagerOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? systemClock;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.onEvent = options.onEvent;
    this.onRotate = options.onRotate;
    this.logger = options.logger;
    this.user = this.loadUser(options.initialUserId);
  }

  /** Start rules 1 to 3: resume a live persisted session or create a new one. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.clock.now();
    const persisted = this.readPersisted();
    if (persisted) {
      const reason = persisted.endedAt ? undefined : this.expiredReason(persisted, now);
      if (!persisted.endedAt && !reason) {
        this.current = persisted;
        this.logger?.log("session resumed", persisted.id);
        this.schedule();
        return;
      }
      if (reason) {
        this.end(persisted, reason, now);
      } else {
        // Ended by another tab earlier; the end event was already emitted there.
        this.lastEnded = persisted;
      }
    }
    this.create(now);
  }

  /** Active session id. Lazily creates a session when the previous one has ended. */
  id(): string {
    return this.ensure().id;
  }

  previousId(): string | undefined {
    return this.ensure().previousId;
  }

  startedAt(): number {
    return this.ensure().startedAt;
  }

  userId(): string {
    return this.user.id;
  }

  isAnonymousUser(): boolean {
    return this.user.anonymous;
  }

  setUser(id: string): void {
    this.user = { id, anonymous: false };
    this.storage.set(USER_STORAGE_KEY, JSON.stringify(this.user));
  }

  /** Activity rule: refresh lastActivity, persist throttled, detect expiry first. */
  touch(): void {
    const now = this.clock.now();
    const session = this.ensure();
    session.lastActivity = now;
    this.persist(session, false);
  }

  /** Next replay chunk sequence number for the active session (persisted immediately, read fresh for other tabs). */
  nextReplaySeq(): number {
    const session = this.ensure();
    const persisted = this.readPersisted();
    if (persisted && persisted.id === session.id && persisted.replaySeq > session.replaySeq) {
      session.replaySeq = persisted.replaySeq;
    }
    const seq = session.replaySeq;
    session.replaySeq = seq + 1;
    this.persist(session, true);
    return seq;
  }

  /** Replay sampling decided once per session and persisted with it. */
  replaySampled(sampleRate: number): boolean {
    const session = this.ensure();
    if (session.replaySampled === undefined) {
      session.replaySampled = sampleRate >= 1 ? true : sampleRate <= 0 ? false : Math.random() < sampleRate;
      this.persist(session, true);
    }
    return session.replaySampled;
  }

  /** Cross-tab sync (start rule 4): called with the new value of the `ouo.session` key. */
  handleStorageEvent(newValue: string | null): void {
    const rec = parse<SessionRecord>(newValue);
    if (!rec || typeof rec.id !== "string") return;
    if (this.current && rec.id === this.current.id) {
      if (rec.endedAt) {
        this.logger?.log("session ended by another tab", rec.id, rec.endReason);
        this.lastEnded = rec;
        this.current = null;
        this.clearTimer();
        return;
      }
      this.current.lastActivity = Math.max(this.current.lastActivity, rec.lastActivity);
      this.current.replaySeq = Math.max(this.current.replaySeq, rec.replaySeq);
      if (rec.replaySampled !== undefined) this.current.replaySampled = rec.replaySampled;
      return;
    }
    if (rec.endedAt) return;
    // Another tab started a new session: adopt it without emitting session.start again.
    const previousId = this.current?.id;
    this.logger?.log("session adopted from another tab", rec.id);
    if (this.current) this.lastEnded = this.current;
    this.current = rec;
    this.schedule();
    this.onRotate?.(rec, previousId);
  }

  /** Current session snapshot without side effects (null when ended and not yet replaced). */
  peek(): SessionRecord | null {
    return this.current;
  }

  stop(): void {
    this.clearTimer();
    if (this.current) this.persist(this.current, true);
  }

  // ---- internals ----

  private ensure(): SessionRecord {
    const now = this.clock.now();
    if (this.current) {
      const reason = this.expiredReason(this.current, now);
      if (!reason) return this.current;
      this.end(this.current, reason, now);
    }
    return this.create(now);
  }

  private expiredReason(rec: SessionRecord, now: number): EndReason | undefined {
    const inactivityDeadline = rec.lastActivity + this.inactivityTimeoutMs;
    const maxDeadline = rec.startedAt + this.maxDurationMs;
    if (now < inactivityDeadline && now < maxDeadline) return undefined;
    return inactivityDeadline <= maxDeadline ? "inactivity" : "max_duration";
  }

  private create(now: number): SessionRecord {
    const previousId = this.lastEnded?.id;
    const rec: SessionRecord = {
      id: uuidv4(),
      startedAt: now,
      lastActivity: now,
      replaySeq: 0,
    };
    if (previousId) rec.previousId = previousId;
    this.current = rec;
    this.persist(rec, true);
    this.logger?.log("session started", rec.id, previousId ? `(previous ${previousId})` : "");
    const attributes: Attrs = {
      "session.id": rec.id,
      "ouo.session.started_at": rec.startedAt,
    };
    if (previousId) attributes["session.previous_id"] = previousId;
    this.onEvent({ name: "session.start", attributes });
    this.schedule();
    this.onRotate?.(rec, previousId);
    return rec;
  }

  private end(rec: SessionRecord, reason: EndReason, now: number): void {
    const endedAt =
      reason === "inactivity"
        ? Math.min(rec.lastActivity + this.inactivityTimeoutMs, now)
        : Math.min(rec.startedAt + this.maxDurationMs, now);
    rec.endedAt = endedAt;
    rec.endReason = reason;
    this.lastEnded = rec;
    if (this.current === rec) this.current = null;
    this.clearTimer();
    // Persist the ended marker first so other tabs do not emit a second session.end.
    this.persist(rec, true);
    this.logger?.log("session ended", rec.id, reason);
    const attributes: Attrs = {
      "session.id": rec.id,
      "ouo.session.end_reason": reason,
      "ouo.session.duration_ms": Math.max(0, endedAt - rec.startedAt),
      "ouo.session.started_at": rec.startedAt,
      "ouo.session.ended_at": endedAt,
    };
    if (rec.previousId) attributes["session.previous_id"] = rec.previousId;
    this.onEvent({ name: "session.end", attributes });
  }

  /** Same-tab expiry detection: one timer at the earliest deadline, re-evaluated when it fires. */
  private schedule(): void {
    this.clearTimer();
    const rec = this.current;
    if (!rec) return;
    const now = this.clock.now();
    const deadline = Math.min(rec.lastActivity + this.inactivityTimeoutMs, rec.startedAt + this.maxDurationMs);
    const delay = Math.max(0, deadline - now);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.onTimer();
    }, delay);
  }

  private onTimer(): void {
    const rec = this.current;
    if (!rec) return;
    // Another tab may have recorded activity since we last looked.
    const persisted = this.readPersisted();
    if (persisted && persisted.id === rec.id) {
      if (persisted.endedAt) {
        this.lastEnded = persisted;
        this.current = null;
        return;
      }
      rec.lastActivity = Math.max(rec.lastActivity, persisted.lastActivity);
    }
    const now = this.clock.now();
    const reason = this.expiredReason(rec, now);
    if (reason) {
      this.end(rec, reason, now);
    } else {
      this.schedule();
    }
  }

  private readPersisted(): SessionRecord | null {
    const rec = parse<SessionRecord>(this.storage.get(SESSION_STORAGE_KEY));
    if (!rec || typeof rec.id !== "string" || typeof rec.startedAt !== "number") return null;
    if (typeof rec.lastActivity !== "number") rec.lastActivity = rec.startedAt;
    if (typeof rec.replaySeq !== "number") rec.replaySeq = 0;
    return rec;
  }

  private persist(rec: SessionRecord, force: boolean): void {
    const now = this.clock.now();
    if (!force && now - this.lastPersist < PERSIST_THROTTLE_MS) return;
    this.lastPersist = now;
    this.storage.set(SESSION_STORAGE_KEY, JSON.stringify(rec));
  }

  private loadUser(initialUserId: string | undefined): UserRecord {
    if (initialUserId) {
      const user = { id: initialUserId, anonymous: false };
      this.storage.set(USER_STORAGE_KEY, JSON.stringify(user));
      return user;
    }
    const persisted = parse<UserRecord>(this.storage.get(USER_STORAGE_KEY));
    if (persisted && typeof persisted.id === "string") {
      return { id: persisted.id, anonymous: persisted.anonymous !== false };
    }
    const user = { id: uuidv4(), anonymous: true };
    this.storage.set(USER_STORAGE_KEY, JSON.stringify(user));
    return user;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
