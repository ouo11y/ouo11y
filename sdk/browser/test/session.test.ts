import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, SESSION_STORAGE_KEY, USER_STORAGE_KEY, type SessionEvent } from "../src/session/manager";
import { MemoryStorage } from "../src/session/storage";
import { isSampled } from "../src/session/sampling";
import type { Clock } from "../src/session/clock";

const MIN = 60_000;
const HOUR = 60 * MIN;
const INACTIVITY = 30 * MIN;
const MAX = 4 * HOUR;

/** Clock driven by vitest fake timers (Date.now advances with the timers). */
const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function makeManager(storage: MemoryStorage, events: SessionEvent[], rotations: string[] = []) {
  return new SessionManager({
    storage,
    clock: fakeClock,
    inactivityTimeoutMs: INACTIVITY,
    maxDurationMs: MAX,
    onEvent: (e) => events.push(e),
    onRotate: (next) => rotations.push(next.id),
  });
}

function persisted(storage: MemoryStorage) {
  return JSON.parse(storage.get(SESSION_STORAGE_KEY)!) as {
    id: string;
    startedAt: number;
    lastActivity: number;
    previousId?: string;
    replaySeq: number;
    endedAt?: number;
    endReason?: string;
  };
}

describe("SessionManager (docs/specs/session-lifecycle.md)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
  });

  it("case 1: fresh init creates a session and emits session.start", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const m = makeManager(storage, events);
    m.start();
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("session.start");
    expect(events[0]!.attributes["session.id"]).toBe(m.id());
    expect(events[0]!.attributes["ouo.session.started_at"]).toBe(Date.now());
    expect(events[0]!.attributes["session.previous_id"]).toBeUndefined();
    expect(m.id()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(persisted(storage).id).toBe(m.id());
    expect(persisted(storage).replaySeq).toBe(0);
  });

  it("case 2: init within the inactivity window resumes the session with no new event", () => {
    const storage = new MemoryStorage();
    const events1: SessionEvent[] = [];
    const m1 = makeManager(storage, events1);
    m1.start();
    const id = m1.id();
    m1.stop();

    vi.advanceTimersByTime(10 * MIN);
    const events2: SessionEvent[] = [];
    const m2 = makeManager(storage, events2);
    m2.start();
    expect(m2.id()).toBe(id);
    expect(events2).toHaveLength(0);
  });

  it("case 3: init after the inactivity window ends the old session (inactivity) and starts a new one with previous_id", () => {
    const storage = new MemoryStorage();
    const m1 = makeManager(storage, []);
    m1.start();
    const oldId = m1.id();
    const startedAt = Date.now();
    m1.stop();

    vi.setSystemTime(startedAt + INACTIVITY + 5 * MIN);
    const events: SessionEvent[] = [];
    const m2 = makeManager(storage, events);
    m2.start();

    expect(events.map((e) => e.name)).toEqual(["session.end", "session.start"]);
    const end = events[0]!.attributes;
    expect(end["session.id"]).toBe(oldId);
    expect(end["ouo.session.end_reason"]).toBe("inactivity");
    expect(end["ouo.session.duration_ms"]).toBe(INACTIVITY);
    const start = events[1]!.attributes;
    expect(start["session.id"]).toBe(m2.id());
    expect(start["session.previous_id"]).toBe(oldId);
    expect(m2.id()).not.toBe(oldId);
    expect(m2.previousId()).toBe(oldId);
  });

  it("case 4: activity after MAX_DURATION rotates the session (max_duration), timer path", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const m = makeManager(storage, events);
    m.start();
    const oldId = m.id();
    // Keep the user active every 10 minutes so inactivity never triggers.
    for (let t = 0; t < MAX; t += 10 * MIN) {
      vi.advanceTimersByTime(10 * MIN);
      if (t + 10 * MIN < MAX) m.touch();
    }
    // The max-duration timer has fired: the session is ended but not replaced until activity.
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end"]);
    expect(events[1]!.attributes["ouo.session.end_reason"]).toBe("max_duration");
    expect(events[1]!.attributes["ouo.session.duration_ms"]).toBe(MAX);
    expect(m.peek()).toBeNull();

    m.touch();
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end", "session.start"]);
    expect(m.id()).not.toBe(oldId);
    expect(events[2]!.attributes["session.previous_id"]).toBe(oldId);
  });

  it("case 4 (no timer): activity after MAX_DURATION detected on touch()", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const noTimerClock: Clock = { now: () => Date.now(), setTimeout: () => null, clearTimeout: () => undefined };
    const m = new SessionManager({ storage, clock: noTimerClock, inactivityTimeoutMs: INACTIVITY, maxDurationMs: MAX, onEvent: (e) => events.push(e) });
    m.start();
    const oldId = m.id();
    for (let t = 10 * MIN; t < MAX; t += 10 * MIN) {
      vi.setSystemTime(Date.now() + 10 * MIN);
      m.touch();
    }
    vi.setSystemTime(Date.now() + 10 * MIN);
    m.touch();
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end", "session.start"]);
    expect(events[1]!.attributes["ouo.session.end_reason"]).toBe("max_duration");
    expect(m.id()).not.toBe(oldId);
  });

  it("same-tab inactivity timer ends the session and the next signal starts a new one", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const m = makeManager(storage, events);
    m.start();
    const oldId = m.id();
    vi.advanceTimersByTime(INACTIVITY);
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end"]);
    expect(events[1]!.attributes["ouo.session.end_reason"]).toBe("inactivity");
    expect(persisted(storage).endedAt).toBeDefined();
    // A span starting now needs a session id: a new session is created lazily.
    const newId = m.id();
    expect(newId).not.toBe(oldId);
    expect(events[2]!.name).toBe("session.start");
    expect(events[2]!.attributes["session.previous_id"]).toBe(oldId);
  });

  it("activity persists lastActivity throttled to once per second", () => {
    const storage = new MemoryStorage();
    const m = makeManager(storage, []);
    m.start();
    const t0 = persisted(storage).lastActivity;
    vi.advanceTimersByTime(500);
    m.touch();
    expect(persisted(storage).lastActivity).toBe(t0);
    vi.advanceTimersByTime(600);
    m.touch();
    expect(persisted(storage).lastActivity).toBe(t0 + 1100);
  });

  it("cross-tab: storage event with a new session id adopts it without emitting session.start", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const rotations: string[] = [];
    const m = makeManager(storage, events, rotations);
    m.start();
    const oldId = m.id();
    const other = { id: "11111111-1111-4111-8111-111111111111", startedAt: Date.now(), lastActivity: Date.now(), replaySeq: 0, previousId: oldId };
    m.handleStorageEvent(JSON.stringify(other));
    expect(m.id()).toBe(other.id);
    expect(events).toHaveLength(1);
    expect(rotations).toEqual([oldId, other.id]);
  });

  it("cross-tab: storage event with an ended marker drops the session without a second session.end", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const m = makeManager(storage, events);
    m.start();
    const rec = persisted(storage);
    m.handleStorageEvent(JSON.stringify({ ...rec, endedAt: Date.now(), endReason: "inactivity" }));
    expect(m.peek()).toBeNull();
    expect(events).toHaveLength(1);
  });

  it("cross-tab: activity in another tab postpones this tab's inactivity timer", () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const m = makeManager(storage, events);
    m.start();
    vi.advanceTimersByTime(20 * MIN);
    const rec = persisted(storage);
    m.handleStorageEvent(JSON.stringify({ ...rec, lastActivity: Date.now() }));
    vi.advanceTimersByTime(15 * MIN);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(15 * MIN);
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end"]);
  });

  it("replay seq persists with the session and continues after a reload; a new session resets to 0", () => {
    const storage = new MemoryStorage();
    const m1 = makeManager(storage, []);
    m1.start();
    expect(m1.nextReplaySeq()).toBe(0);
    expect(m1.nextReplaySeq()).toBe(1);
    expect(m1.nextReplaySeq()).toBe(2);
    expect(persisted(storage).replaySeq).toBe(3);
    m1.stop();

    vi.advanceTimersByTime(MIN);
    const m2 = makeManager(storage, []);
    m2.start();
    expect(m2.nextReplaySeq()).toBe(3);

    vi.advanceTimersByTime(INACTIVITY + MIN);
    const m3 = makeManager(storage, []);
    m3.start();
    expect(m3.nextReplaySeq()).toBe(0);
  });

  it("replay sampling is decided once per session from its id and persisted", () => {
    const storage = new MemoryStorage();
    const m = makeManager(storage, []);
    m.start();
    const decided = m.replaySampled(0.5);
    expect(decided).toBe(isSampled(m.id(), 0.5, "replay"));
    // Persisted: a later call with another rate keeps the first decision.
    expect(m.replaySampled(decided ? 0 : 1)).toBe(decided);
    expect(JSON.parse(storage.get(SESSION_STORAGE_KEY)!).replaySampled).toBe(decided);
  });

  it("anonymous user id is generated once and persisted under ouo.user", () => {
    const storage = new MemoryStorage();
    const m1 = makeManager(storage, []);
    m1.start();
    expect(m1.isAnonymousUser()).toBe(true);
    const stored = JSON.parse(storage.get(USER_STORAGE_KEY)!);
    expect(stored).toEqual({ id: m1.userId(), anonymous: true });
    const m2 = makeManager(storage, []);
    expect(m2.userId()).toBe(m1.userId());
    m2.setUser("user-42");
    expect(m2.userId()).toBe("user-42");
    expect(m2.isAnonymousUser()).toBe(false);
    expect(JSON.parse(storage.get(USER_STORAGE_KEY)!)).toEqual({ id: "user-42", anonymous: false });
  });

  it("ignores corrupt persisted state", () => {
    const storage = new MemoryStorage();
    storage.set(SESSION_STORAGE_KEY, "{not json");
    const events: SessionEvent[] = [];
    const m = makeManager(storage, events);
    m.start();
    expect(events.map((e) => e.name)).toEqual(["session.start"]);
    expect(m.id()).toBeTruthy();
  });
});
