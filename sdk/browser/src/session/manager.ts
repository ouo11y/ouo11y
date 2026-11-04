import type { Attrs } from "../types";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { uuidv4 } from "./ids";
import { isSampled, type SamplingSalt } from "./sampling";
import type { KeyValueStorage } from "./storage";
import type { DebugLogger } from "../logger";

export const SESSION_STORAGE_KEY = "ouo.session";
export const USER_STORAGE_KEY = "ouo.user";
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
/** Activity is persisted at most once per second (spec: activity rules). */
const PERSIST_THROTTLE_MS = 1000;

/**
 * Why a session ended: timeouts (`inactivity`, `max_duration`), a different identified user
 * (`setUser` with another id, or `clearUser` at logout: `user_change`) or `rum.endSession()`
 * (`manual`). docs/specs/session-lifecycle.md.
 */
export type EndReason = "inactivity" | "max_duration" | "user_change" | "manual";

/** What is persisted under `ouo.session`. Timestamps are Unix epoch milliseconds. */
export interface SessionRecord {
  id: string;
  startedAt: number;
  lastActivity: number;
  previousId?: string;
  /** Next replay chunk sequence number; reloads continue the sequence. */
  replaySeq: number;
  /** Session sampling decision (`session.sampleRate`), taken once per session. */
  sampled?: boolean;
  /** Replay sampling decision, taken once per session. */
  replaySampled?: boolean;
  /** Error-triggered replay decision (`replay.onErrorSampleRate`), taken once per session. */
  replayOnError?: boolean;
  /** An error was reported while replay was buffering: upload from now on (all tabs, reloads). */
  replayTriggered?: boolean;
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
  /**
   * Consent was revoked at this time (epoch ms): a persisted session that started before it is
   * never resumed nor ended from here (another tab may have written it back while it stopped);
   * a new one starts. Sessions started since, by a tab that was granted again, are joined.
   */
  notBefore?: number;
  clock?: Clock;
  inactivityTimeoutMs?: number;
  maxDurationMs?: number;
  /** Receives `session.start` / `session.end`; the caller turns them into OTel log records. */
  onEvent: (event: SessionEvent) => void;
  /** Called whenever the active session id changes (new session created here or adopted from another tab). */
  onRotate?: (next: SessionRecord, previousId: string | undefined) => void;
  initialUserId?: string;
  /** `device.id` put on `session.start` and `session.end` (session/device.ts). */
  deviceId?: string;
  /** Fraction of sessions that send telemetry, decided once per session. Default 1. */
  sessionSampleRate?: number;
  logger?: DebugLogger;
}

const SALTS: Record<"sampled" | "replaySampled" | "replayOnError", SamplingSalt> = {
  sampled: "session",
  replaySampled: "replay",
  replayOnError: "replay_on_error",
};

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
  private readonly sessionSampleRate: number;
  private readonly notBefore: number | undefined;
  private readonly initialUserId: string | undefined;
  private readonly deviceId: string | undefined;

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
    this.sessionSampleRate = options.sessionSampleRate ?? 1;
    this.notBefore = options.notBefore;
    this.initialUserId = options.initialUserId;
    this.deviceId = options.deviceId;
    this.user = this.loadUser();
  }

  /** Start rules 1 to 3: resume a live persisted session or create a new one. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.clock.now();
    let persisted = this.readPersisted();
    if (persisted && this.notBefore !== undefined && persisted.startedAt < this.notBefore) {
      this.logger?.log("session from before the consent revocation ignored", persisted.id);
      persisted = null;
    }
    if (persisted) {
      const reason = persisted.endedAt ? undefined : this.expiredReason(persisted, now);
      if (!persisted.endedAt && !reason) {
        this.current = persisted;
        this.logger?.log("session resumed", persisted.id);
        this.schedule();
        // `user.id` in the options: a different identified user than the resumed session's rotates it.
        if (this.initialUserId) this.setUser(this.initialUserId);
        return;
      }
      if (this.initialUserId) this.saveUser({ id: this.initialUserId, anonymous: false });
      if (reason) {
        this.rotate(persisted, reason, now);
        return;
      }
      // Ended by another tab earlier; the end event was already emitted there.
      this.lastEnded = persisted;
    } else if (this.initialUserId) {
      this.saveUser({ id: this.initialUserId, anonymous: false });
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

  /**
   * Identifies the user. From one identified user to another the session rotates (`user_change`):
   * the `session.end` carries the previous user, the new session the new one. From anonymous to
   * identified (a login during the visit) the session continues with the new user.
   */
  setUser(id: string): void {
    if (!id || (id === this.user.id && !this.user.anonymous)) return;
    const next: UserRecord = { id, anonymous: false };
    if (this.user.anonymous) this.saveUser(next);
    else this.switchUser(next);
  }

  /** Logout: back to a fresh anonymous id, in a new session (`user_change`). */
  clearUser(): void {
    this.switchUser({ id: uuidv4(), anonymous: true });
  }

  /** Ends the session now (`manual`); the next activity or signal starts a new one. */
  endSession(): void {
    const rec = this.current;
    if (rec) this.end(rec, "manual", this.clock.now());
  }

  /** `device.id` of this browser, when the SDK set one. */
  device(): string | undefined {
    return this.deviceId;
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

  /** Session sampling decided once per session and persisted with it: false drops every signal. */
  sampled(): boolean {
    return this.decide(this.ensure(), "sampled", this.sessionSampleRate);
  }

  /**
   * Sampling decision of a named session without creating one: the active session, the last
   * ended one (a `session.end` record), else true.
   */
  sampledFor(id: string): boolean {
    const rec = this.current?.id === id ? this.current : this.lastEnded?.id === id ? this.lastEnded : null;
    if (!rec) return true;
    return this.decide(rec, "sampled", this.sessionSampleRate);
  }

  /** Replay sampling decided once per session and persisted with it. */
  replaySampled(sampleRate: number): boolean {
    return this.decide(this.ensure(), "replaySampled", sampleRate);
  }

  /** Error-triggered replay sampling decided once per session and persisted with it. */
  replayOnError(sampleRate: number): boolean {
    return this.decide(this.ensure(), "replayOnError", sampleRate);
  }

  /** Whether an error switched this session's buffered replay to uploading. */
  replayTriggered(): boolean {
    return this.ensure().replayTriggered === true;
  }

  /** An error happened while replay was buffering: every tab of this session uploads from now on. */
  triggerReplay(): void {
    const session = this.ensure();
    if (session.replayTriggered) return;
    session.replayTriggered = true;
    this.persist(session, true);
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
      if (rec.sampled !== undefined) this.current.sampled = rec.sampled;
      if (rec.replayOnError !== undefined) this.current.replayOnError = rec.replayOnError;
      if (rec.replayTriggered) this.current.replayTriggered = true;
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

  /**
   * The shared rule (./sampling.ts): a hash of the session id, so rum-api's per-project cap keeps a
   * consistent subset. Persisted with the session all the same: the rate can change between page
   * loads (a deploy) and a session keeps its first decision.
   */
  private decide(rec: SessionRecord, key: "sampled" | "replaySampled" | "replayOnError", rate: number): boolean {
    let v = rec[key];
    if (v === undefined) {
      v = isSampled(rec.id, rate, SALTS[key]);
      rec[key] = v;
      if (rec === this.current) this.persist(rec, true);
    }
    return v;
  }

  private ensure(): SessionRecord {
    const now = this.clock.now();
    if (this.current) {
      const reason = this.expiredReason(this.current, now);
      if (!reason) return this.current;
      return this.rotate(this.current, reason, now);
    }
    return this.create(now);
  }

  private expiredReason(rec: SessionRecord, now: number): EndReason | undefined {
    const inactivityDeadline = rec.lastActivity + this.inactivityTimeoutMs;
    const maxDeadline = rec.startedAt + this.maxDurationMs;
    if (now < inactivityDeadline && now < maxDeadline) return undefined;
    return inactivityDeadline <= maxDeadline ? "inactivity" : "max_duration";
  }

  /**
   * Replace an expired session with a new one. State is fully updated (old record
   * closed and persisted, new record installed as `current`) before either event is
   * emitted, so a re-entrant `ensure()` from an event consumer (the OTel log processor
   * asks for the active id while `session.end` is being emitted) returns the replacement
   * instead of creating a second session. Exactly one `session.end` and one
   * `session.start` are emitted per rotation.
   */
  private rotate(rec: SessionRecord, reason: EndReason, now: number, between?: () => void): SessionRecord {
    const endAttributes = this.close(rec, reason, now);
    const next = this.install(now);
    this.onEvent({ name: "session.end", attributes: endAttributes });
    between?.();
    this.announce(next);
    return next;
  }

  /** Another user: rotate the live session, switching the user between its end and the next start. */
  private switchUser(next: UserRecord): void {
    const rec = this.current;
    if (!rec || this.expiredReason(rec, this.clock.now())) {
      this.saveUser(next);
      return;
    }
    this.rotate(rec, "user_change", this.clock.now(), () => this.saveUser(next));
  }

  private saveUser(user: UserRecord): void {
    this.user = user;
    this.storage.set(USER_STORAGE_KEY, JSON.stringify(user));
  }

  private create(now: number): SessionRecord {
    const rec = this.install(now);
    this.announce(rec);
    return rec;
  }

  /** Create and persist a new record as the active session without emitting anything. */
  private install(now: number): SessionRecord {
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
    return rec;
  }

  /** Emit `session.start` for an installed record, arm the expiry timer and notify listeners. */
  private announce(rec: SessionRecord): void {
    const attributes: Attrs = {
      "session.id": rec.id,
      "ouo.session.started_at": rec.startedAt,
    };
    if (rec.previousId) attributes["session.previous_id"] = rec.previousId;
    if (this.deviceId) attributes["device.id"] = this.deviceId;
    this.onEvent({ name: "session.start", attributes });
    this.schedule();
    this.onRotate?.(rec, rec.previousId);
  }

  /** End a session with no replacement (timer path: the next signal creates one lazily). */
  private end(rec: SessionRecord, reason: EndReason, now: number): void {
    this.onEvent({ name: "session.end", attributes: this.close(rec, reason, now) });
  }

  /** Mark a record ended, persist the marker and return the `session.end` attributes. */
  private close(rec: SessionRecord, reason: EndReason, now: number): Attrs {
    const endedAt =
      reason === "inactivity"
        ? Math.min(rec.lastActivity + this.inactivityTimeoutMs, now)
        : reason === "max_duration"
          ? Math.min(rec.startedAt + this.maxDurationMs, now)
          : now;
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
    if (this.deviceId) attributes["device.id"] = this.deviceId;
    return attributes;
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

  /**
   * The persisted user, or `user.id` from the options when the persisted one is anonymous. A
   * different identified user stays until start(): it decides between a rotation (resumed
   * session) and a plain switch (new session).
   */
  private loadUser(): UserRecord {
    const p = parse<UserRecord>(this.storage.get(USER_STORAGE_KEY));
    const persisted = p && typeof p.id === "string" ? { id: p.id, anonymous: p.anonymous !== false } : null;
    if (this.initialUserId && (!persisted || persisted.anonymous)) {
      const user = { id: this.initialUserId, anonymous: false };
      this.storage.set(USER_STORAGE_KEY, JSON.stringify(user));
      return user;
    }
    if (persisted) return persisted;
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
