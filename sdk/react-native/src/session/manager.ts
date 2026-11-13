import type { DebugLogger } from "../logger";
import type { AsyncKeyValueStorage, Attrs } from "../types";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { SAMPLING_SALT, sampled } from "../sampling";
import { uuidv4 } from "./ids";
import { withTimeout } from "./storage";

export const SESSION_STORAGE_KEY = "ouo.session";
export const USER_STORAGE_KEY = "ouo.user";
export const CRASH_STORAGE_KEY = "ouo.crash";
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 1000;
/** The last-activity time is written to storage at most once per 5 s (spec SES-6). */
export const PERSIST_THROTTLE_MS = 5000;
/** A hung AsyncStorage read must not delay `session.start` for longer than this. */
const STORAGE_READ_TIMEOUT_MS = 1500;

/** `manual`: `restartSession()`; `shutdown`: `shutdown()` (spec SES-7). */
export type EndReason = "inactivity" | "max_duration" | "background" | "crash" | "terminated" | "manual" | "shutdown";

/** What is persisted under `ouo.session`. Timestamps are Unix epoch milliseconds. */
export interface SessionRecord {
  id: string;
  startedAt: number;
  lastActivity: number;
  userId: string;
  /** `service.version` the session ran on, so a session.end emitted after an app update names the right version. */
  serviceVersion?: string;
  previousId?: string;
  /** Set while the app is in the background; cleared on foreground. */
  backgroundAt?: number;
  endedAt?: number;
  endReason?: EndReason;
  /** The sampling decision, made once when the session started (spec SMP-1). Absent in records of older SDKs. */
  sampled?: boolean;
}

/** What is persisted under `ouo.crash` by the fatal error handler. */
export interface CrashMarker {
  sessionId: string;
  at: number;
  /** The crashed session's start, from the native crash report (N52). */
  startedAt?: number;
  type?: string;
  message?: string;
}

interface UserRecord {
  id: string;
  anonymous: boolean;
}

export interface SessionEvent {
  name: "session.start" | "session.end";
  attributes: Attrs;
  /** Epoch milliseconds the event should be stamped with. */
  timestamp: number;
}

/**
 * Per-JS-process memory shared by every manager instance: a second `start()` in the
 * same process (hot re-init) resumes the session (spec case 2), a cold start never does.
 */
export interface ProcessState {
  record?: SessionRecord;
  user?: UserRecord;
}

const GLOBAL_KEY = "__ouoSessionProcessState";

export function processState(): ProcessState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {};
  return g[GLOBAL_KEY] as ProcessState;
}

export interface SessionManagerOptions {
  storage: AsyncKeyValueStorage;
  clock?: Clock;
  inactivityTimeoutMs?: number;
  maxDurationMs?: number;
  backgroundTimeoutMs?: number;
  /** Receives `session.start` / `session.end`; the caller turns them into OTel log records. */
  onEvent: (event: SessionEvent) => void;
  /** Called whenever the active session id changes. */
  onRotate?: (next: SessionRecord, previousId: string | undefined) => void;
  initialUserId?: string;
  /** Stored with the session record and copied onto its session.end. */
  serviceVersion?: string;
  /** `session.sampleRate`, 0 to 1: decided per session at its start and kept with it. Default 1. */
  sampleRate?: number;
  /** Defaults to a global per process; injectable so tests can simulate a cold start. */
  process?: ProcessState;
  /**
   * Crash marker from the native crash report of the previous run (signal or uncaught
   * NSException, `src/crash.ts`). Used like the JS marker; its time is when the process died.
   */
  nativeCrash?: CrashMarker;
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
 * Session state machine for mobile (docs/specs/session-lifecycle.md, mobile rules).
 * Pure: time, storage and process memory are injected.
 */
export class SessionManager {
  private readonly storage: AsyncKeyValueStorage;
  private readonly clock: Clock;
  private readonly inactivityTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly backgroundTimeoutMs: number;
  private readonly onEvent: (event: SessionEvent) => void;
  private readonly onRotate: ((next: SessionRecord, previousId: string | undefined) => void) | undefined;
  private readonly process: ProcessState;
  private readonly serviceVersion: string | undefined;
  private readonly logger: DebugLogger | undefined;
  private readonly nativeCrash: CrashMarker | undefined;
  private readonly sampleRate: number;
  /** Made up once for bypass records when no session id is known at all (spec SES-10). */
  private orphanId: string | undefined;
  /** Consent denied: no session starts (see `forget`). */
  private suspended = false;

  private current: SessionRecord | null = null;
  private lastEnded: SessionRecord | null = null;
  /** Set by `setUser` only (spec PRV-13): there is no anonymous id. */
  private user: UserRecord | undefined;
  private lastPersist = 0;
  private timer: unknown = null;
  private startPromise: Promise<void> | null = null;
  /** Set during a cold start until the persisted state has been read. */
  private pendingStart: SessionRecord | null = null;

  constructor(options: SessionManagerOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? systemClock;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.backgroundTimeoutMs = options.backgroundTimeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    this.onRotate = options.onRotate;
    this.process = options.process ?? processState();
    this.serviceVersion = options.serviceVersion;
    this.logger = options.logger;
    this.nativeCrash = options.nativeCrash;
    this.sampleRate = options.sampleRate ?? 1;
    this.user = this.initialUser(options.initialUserId);
  }

  /**
   * Mobile start rules. Synchronous part: a session id is available immediately.
   * Asynchronous part (the returned promise): the persisted session of the previous
   * run is ended (`crash` / `inactivity` / `max_duration` / `background` / `terminated`)
   * and `session.start` is emitted with `session.previous_id`.
   */
  start(foreground = true): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart(foreground);
    return this.startPromise;
  }

  /**
   * `foreground` false is a background launch (a push, a background fetch): the previous run's
   * session is still closed, but no session starts until the first activity (spec LIF-13).
   */
  private doStart(foreground: boolean): Promise<void> {
    const now = this.clock.now();

    const cached = this.process.record;
    if (cached && !cached.endedAt) {
      // Same JS process: resume unless expired (spec cases 2 and 3 for a warm re-init).
      const reason = this.expiredReason(cached, now);
      if (!reason) {
        this.current = cached;
        this.logger?.log("session resumed", cached.id);
        this.schedule();
        return Promise.resolve();
      }
      this.end(cached, reason, now);
      if (foreground) this.create(now, true);
      return Promise.resolve();
    }

    // Cold start: new session now, session.start once the previous run's record is known.
    return this.resolveColdStart(foreground ? this.create(now, false) : null, now);
  }

  /**
   * The valid session, without creating one (spec SES-10: telemetry, timers and network never
   * start a session; activity does, through `touch`). An expired session is ended here.
   */
  active(): SessionRecord | undefined {
    const rec = this.current;
    if (!rec) return undefined;
    const now = this.clock.now();
    const reason = this.expiredReason(rec, now);
    if (!reason) return rec;
    this.expire(rec, reason, now);
    return this.current ?? undefined;
  }

  /**
   * The session id for a bypass-set record emitted while no session is valid (SES-10): the last
   * session's, or one made up for the purpose (no `session.start` is emitted for it).
   */
  lastId(): string {
    return this.current?.id ?? this.lastEnded?.id ?? (this.orphanId ??= uuidv4());
  }

  /** The sampling decision of a session this manager knows (the current or the last ended one). */
  sampledFor(id: string): boolean | undefined {
    if (this.current?.id === id) return this.current.sampled;
    if (this.lastEnded?.id === id) return this.lastEnded.sampled;
    return undefined;
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

  /** The id given to `setUser`, "" when there is none (spec PRV-13: no id is made up). */
  userId(): string {
    return this.user?.id ?? "";
  }

  setUser(id: string): void {
    this.user = { id, anonymous: false };
    this.process.user = this.user;
    void this.storage.setItem(USER_STORAGE_KEY, JSON.stringify(this.user));
    if (this.current) {
      this.current.userId = id;
      this.persist(this.current, true);
    }
  }

  /** `setUser(null)`: no user id from here on. */
  clearUser(): void {
    this.user = undefined;
    delete this.process.user;
    void this.storage.removeItem(USER_STORAGE_KEY);
    if (this.current) {
      this.current.userId = "";
      this.persist(this.current, true);
    }
  }

  /** `restartSession()`: ends the session with reason `manual` and starts the next one, linked to it. */
  restart(): void {
    if (this.suspended) return;
    const now = this.clock.now();
    if (this.current) this.end(this.current, "manual", now);
    this.create(now, true);
  }

  /** `shutdown()`: ends the active session with reason `shutdown`. The next `init` starts a new one. */
  shutdown(): void {
    if (this.current) this.end(this.current, "shutdown", this.clock.now());
    this.clearTimer();
  }

  /**
   * Consent withdrawn (spec PRV-4): the session is forgotten without a `session.end`, and so is
   * the last ended one, so the session a later grant starts has no `session.previous_id`. The
   * caller deletes the persisted record. No session starts until `resume()`: activity while
   * consent is denied is not recorded, and no id is made that could leave the device.
   */
  forget(): void {
    this.suspended = true;
    this.clearTimer();
    this.current = null;
    this.lastEnded = null;
    this.pendingStart = null;
    this.orphanId = undefined;
    delete this.process.record;
  }

  /** Consent granted again: activity starts sessions again. */
  resume(): void {
    this.suspended = false;
  }

  /** Activity rule: refresh lastActivity, persist throttled, detect expiry first. */
  touch(): void {
    if (this.suspended) return;
    const now = this.clock.now();
    const session = this.ensure();
    session.lastActivity = now;
    this.persist(session, false);
  }

  /** AppState -> background / inactive. Persists immediately so a kill in background is attributable. */
  onBackground(): void {
    if (this.suspended) return;
    const rec = this.current;
    if (!rec || rec.backgroundAt !== undefined) return;
    rec.backgroundAt = this.clock.now();
    this.persist(rec, true);
    this.schedule();
    this.logger?.log("app backgrounded", rec.id);
  }

  /** AppState -> active. Rotates the session when the background stay exceeded the timeout (spec rule 2). */
  onForeground(): void {
    if (this.suspended) return;
    const rec = this.current;
    const now = this.clock.now();
    if (rec) {
      const reason = this.expiredReason(rec, now);
      if (reason) {
        this.end(rec, reason, now);
      } else {
        delete rec.backgroundAt;
      }
    }
    // Foreground is activity: creates the replacement session when the old one ended.
    this.touch();
  }

  /** Writes the crash marker for the active session (fatal error path). */
  markCrash(info: { type?: string; message?: string }): Promise<void> {
    const rec = this.current ?? this.lastEnded;
    const marker: CrashMarker = {
      sessionId: rec?.id ?? "",
      at: this.clock.now(),
      ...(info.type ? { type: info.type } : {}),
      ...(info.message ? { message: info.message.slice(0, 500) } : {}),
    };
    return this.storage.setItem(CRASH_STORAGE_KEY, JSON.stringify(marker));
  }

  /** Current session snapshot without side effects (null when ended and not yet replaced). */
  peek(): SessionRecord | null {
    return this.current;
  }

  /** Last ended session, for records that must name it (session.end). */
  peekLastEnded(): SessionRecord | null {
    return this.lastEnded;
  }

  /** Persist the current record immediately (used by flush, so lastActivity survives a kill). */
  persistNow(): void {
    if (this.current) this.persist(this.current, true);
  }

  stop(): void {
    this.clearTimer();
    this.persistNow();
  }

  // ---- internals ----

  private async resolveColdStart(rec: SessionRecord | null, now: number): Promise<void> {
    const [rawSession, rawCrash, rawUser] = await withTimeout(
      Promise.all([
        this.storage.getItem(SESSION_STORAGE_KEY),
        this.storage.getItem(CRASH_STORAGE_KEY),
        this.storage.getItem(USER_STORAGE_KEY),
      ]),
      STORAGE_READ_TIMEOUT_MS,
      [null, null, null] as [string | null, string | null, string | null],
    );
    // The persisted record may already be ours: persist() ran synchronously in create().
    const persisted = this.validRecord(parse<SessionRecord>(rawSession));
    const jsCrash = parse<CrashMarker>(rawCrash);
    const persistedUser = parse<UserRecord>(rawUser);

    if (!this.user && persistedUser) {
      if (typeof persistedUser.id === "string" && persistedUser.id !== "" && persistedUser.anonymous === false) {
        // No user given at init: the user an earlier run set with `setUser` is still the user.
        this.user = { id: persistedUser.id, anonymous: false };
        this.process.user = this.user;
        if (rec) rec.userId = this.user.id;
      } else {
        // An anonymous id written by an older SDK: not used any more (PRV-13), and removed.
        void this.storage.removeItem(USER_STORAGE_KEY);
      }
    }

    const crash = this.pickCrash(jsCrash, persisted);
    // A session created meanwhile (the app came to the foreground during a background launch's read).
    const mine = rec ?? this.current;
    if (persisted && persisted.id !== mine?.id) {
      if (!persisted.endedAt) {
        const reason = this.coldStartReason(persisted, crash);
        const endedAt = this.coldStartEndedAt(persisted, reason, crash, rec?.startedAt ?? now);
        this.endPersisted(persisted, reason, endedAt);
      } else if (!this.lastEnded) {
        this.lastEnded = persisted;
      }
      if (rec) rec.previousId = persisted.id;
    }
    const lost = this.crashedUnpersisted(persisted, mine?.id, rec?.startedAt ?? now);
    if (lost) {
      this.endPersisted(lost, "crash", lost.lastActivity);
      if (rec) rec.previousId = lost.id;
    }
    if (jsCrash) void this.storage.removeItem(CRASH_STORAGE_KEY);

    this.pendingStart = null;
    if (rec && this.current === rec) {
      this.persist(rec, true);
      this.emitStart(rec);
      this.onRotate?.(rec, rec.previousId);
    }
  }

  /**
   * The native report wins when it names the persisted session: the process died at its time (a
   * JS fatal's marker is written a flush earlier, and React Native then aborts natively).
   */
  private pickCrash(js: CrashMarker | null, persisted: SessionRecord | null): CrashMarker | null {
    const native = this.nativeCrash;
    if (native && persisted && native.sessionId === persisted.id) return native;
    if (js) return js;
    return native && !native.sessionId ? native : null;
  }

  /**
   * N52: the native crash names a session the storage never saw (the process died before the
   * write landed, in its first second). Rebuilt from the crash report so it still ends, from its
   * start, with reason crash.
   */
  private crashedUnpersisted(persisted: SessionRecord | null, currentId: string | undefined, now: number): SessionRecord | null {
    const native = this.nativeCrash;
    if (!native?.sessionId || native.sessionId === currentId || native.sessionId === persisted?.id) return null;
    const at = Math.min(native.at, now);
    const startedAt = native.startedAt !== undefined && native.startedAt <= at ? native.startedAt : at;
    const lost: SessionRecord = { id: native.sessionId, startedAt, lastActivity: at, userId: this.userId() };
    if (this.serviceVersion !== undefined) lost.serviceVersion = this.serviceVersion;
    return lost;
  }

  private coldStartReason(persisted: SessionRecord, crash: CrashMarker | null): EndReason {
    if (crash && (!crash.sessionId || crash.sessionId === persisted.id)) return "crash";
    const expired = this.expiredReason(persisted, this.clock.now());
    if (expired) return expired;
    return "terminated";
  }

  private coldStartEndedAt(persisted: SessionRecord, reason: EndReason, crash: CrashMarker | null, now: number): number {
    switch (reason) {
      case "crash":
        return Math.max(persisted.startedAt, Math.min(crash?.at ?? persisted.lastActivity, now));
      case "inactivity":
        return persisted.lastActivity + this.inactivityTimeoutMs;
      case "max_duration":
        return persisted.startedAt + this.maxDurationMs;
      case "background":
        return (persisted.backgroundAt ?? persisted.lastActivity) + this.backgroundTimeoutMs;
      default:
        return Math.min(persisted.lastActivity, now);
    }
  }

  private ensure(): SessionRecord {
    if (!this.startPromise) void this.start();
    const now = this.clock.now();
    if (this.current) {
      const reason = this.expiredReason(this.current, now);
      if (!reason) return this.current;
      this.end(this.current, reason, now);
    }
    return this.create(now, true);
  }

  /**
   * Ends an expired session. At the maximum duration with the app in the foreground the user is
   * present: the next session starts at once, linked to it (spec SES-9). Otherwise the next one
   * starts with the next activity.
   */
  private expire(rec: SessionRecord, reason: EndReason, now: number): void {
    const present = reason === "max_duration" && rec.backgroundAt === undefined;
    this.end(rec, reason, now);
    if (present) this.create(now, true);
  }

  /** Earliest deadline wins: inactivity, max duration, or background stay (when backgrounded). */
  private expiredReason(rec: SessionRecord, now: number): EndReason | undefined {
    const deadlines: Array<[EndReason, number]> = [
      ["inactivity", rec.lastActivity + this.inactivityTimeoutMs],
      ["max_duration", rec.startedAt + this.maxDurationMs],
    ];
    if (rec.backgroundAt !== undefined) deadlines.push(["background", rec.backgroundAt + this.backgroundTimeoutMs]);
    deadlines.sort((a, b) => a[1] - b[1]);
    const first = deadlines[0]!;
    return now >= first[1] ? first[0] : undefined;
  }

  private create(now: number, emit: boolean): SessionRecord {
    const previousId = this.lastEnded?.id;
    const rec: SessionRecord = {
      id: uuidv4(),
      startedAt: now,
      lastActivity: now,
      userId: this.userId(),
    };
    // SMP-1: decided once, here, and persisted with the session.
    rec.sampled = sampled(rec.id, this.sampleRate, SAMPLING_SALT.session);
    if (this.serviceVersion !== undefined) rec.serviceVersion = this.serviceVersion;
    if (previousId) rec.previousId = previousId;
    this.current = rec;
    this.process.record = rec;
    if (!emit) this.pendingStart = rec;
    this.persist(rec, true);
    this.logger?.log("session started", rec.id, previousId ? `(previous ${previousId})` : "");
    this.schedule();
    if (emit) {
      this.emitStart(rec);
      this.onRotate?.(rec, previousId);
    }
    return rec;
  }

  private emitStart(rec: SessionRecord): void {
    const attributes: Attrs = {
      "session.id": rec.id,
      "ouo.session.started_at": rec.startedAt,
      // Lets consumers scale counts of sampled sessions (spec SMP-3).
      "ouo.session.sample_rate": this.sampleRate,
    };
    if (rec.userId) attributes["user.id"] = rec.userId;
    if (rec.previousId) attributes["session.previous_id"] = rec.previousId;
    this.onEvent({ name: "session.start", attributes, timestamp: rec.startedAt });
  }

  private end(rec: SessionRecord, reason: EndReason, now: number): void {
    let endedAt: number;
    switch (reason) {
      case "inactivity":
        endedAt = Math.min(rec.lastActivity + this.inactivityTimeoutMs, now);
        break;
      case "max_duration":
        endedAt = Math.min(rec.startedAt + this.maxDurationMs, now);
        break;
      case "background":
        endedAt = Math.min((rec.backgroundAt ?? now) + this.backgroundTimeoutMs, now);
        break;
      default:
        endedAt = now;
    }
    this.endPersisted(rec, reason, endedAt);
  }

  /** Marks `rec` ended, persists the marker (so the next launch does not end it again) and emits session.end. */
  private endPersisted(rec: SessionRecord, reason: EndReason, endedAt: number): void {
    rec.endedAt = endedAt;
    rec.endReason = reason;
    delete rec.backgroundAt;
    this.lastEnded = rec;
    if (this.current === rec) {
      this.current = null;
      this.process.record = rec;
      this.clearTimer();
      this.persist(rec, true);
    }
    this.logger?.log("session ended", rec.id, reason);
    const attributes: Attrs = {
      "session.id": rec.id,
      "ouo.session.end_reason": reason,
      "ouo.session.duration_ms": Math.max(0, endedAt - rec.startedAt),
      "ouo.session.started_at": rec.startedAt,
      "ouo.session.ended_at": endedAt,
    };
    if (rec.userId) attributes["user.id"] = rec.userId;
    if (rec.serviceVersion !== undefined) attributes["service.version"] = rec.serviceVersion;
    if (rec.previousId) attributes["session.previous_id"] = rec.previousId;
    this.onEvent({ name: "session.end", attributes, timestamp: endedAt });
  }

  /** In-process expiry detection: one timer at the earliest deadline, re-evaluated when it fires. */
  private schedule(): void {
    this.clearTimer();
    const rec = this.current;
    if (!rec) return;
    const now = this.clock.now();
    const candidates = [rec.lastActivity + this.inactivityTimeoutMs, rec.startedAt + this.maxDurationMs];
    if (rec.backgroundAt !== undefined) candidates.push(rec.backgroundAt + this.backgroundTimeoutMs);
    const delay = Math.max(0, Math.min(...candidates) - now);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.onTimer();
    }, delay);
  }

  private onTimer(): void {
    const rec = this.current;
    if (!rec) return;
    const now = this.clock.now();
    const reason = this.expiredReason(rec, now);
    if (reason) {
      // Ended lazily (the replacement session is created on the next activity), except at the
      // maximum duration with the user present.
      this.expire(rec, reason, now);
    } else {
      this.schedule();
    }
  }

  private validRecord(rec: SessionRecord | null): SessionRecord | null {
    if (!rec || typeof rec.id !== "string" || typeof rec.startedAt !== "number") return null;
    if (typeof rec.lastActivity !== "number") rec.lastActivity = rec.startedAt;
    if (typeof rec.userId !== "string") rec.userId = this.userId();
    return rec;
  }

  private persist(rec: SessionRecord, force: boolean): void {
    // AsyncStorage runs operations in order: a write issued before the cold-start read would
    // overwrite the previous run's record before it is read. The read path persists afterwards.
    if (this.pendingStart === rec) return;
    const now = this.clock.now();
    if (!force && now - this.lastPersist < PERSIST_THROTTLE_MS) return;
    this.lastPersist = now;
    void this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(rec));
  }

  private initialUser(initialUserId: string | undefined): UserRecord | undefined {
    if (initialUserId) {
      const user = { id: initialUserId, anonymous: false };
      this.process.user = user;
      void this.storage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
      return user;
    }
    // A user set earlier in this process; one persisted by an earlier run is adopted during the cold start read.
    return this.process.user && this.process.user.anonymous === false ? this.process.user : undefined;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
