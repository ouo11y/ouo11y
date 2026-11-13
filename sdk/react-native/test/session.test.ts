import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/session/clock";
import {
  CRASH_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  SessionManager,
  USER_STORAGE_KEY,
  type ProcessState,
  type SessionEvent,
  type SessionRecord,
} from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const INACTIVITY = 30 * MIN;
const MAX = 4 * HOUR;
const BACKGROUND = 30 * SEC;

/** Clock driven by vitest fake timers (Date.now advances with the timers). */
const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Launch {
  manager: SessionManager;
  events: SessionEvent[];
  process: ProcessState;
}

/** A "launch" is a manager with its own process memory; reusing `process` means a warm re-init. */
function launch(storage: MemoryAsyncStorage, process: ProcessState = {}, extra: { initialUserId?: string; serviceVersion?: string } = {}): Launch {
  const events: SessionEvent[] = [];
  const manager = new SessionManager({
    storage,
    serviceVersion: "2.3.0",
    clock: fakeClock,
    inactivityTimeoutMs: INACTIVITY,
    maxDurationMs: MAX,
    backgroundTimeoutMs: BACKGROUND,
    process,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { manager, events, process };
}

function persisted(storage: MemoryAsyncStorage): SessionRecord {
  return JSON.parse(storage.peek(SESSION_STORAGE_KEY)!) as SessionRecord;
}

const UUID = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

describe("SessionManager (docs/specs/session-lifecycle.md, mobile)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
  });

  it("case 1: fresh init creates a session and emits session.start", async () => {
    const storage = new MemoryAsyncStorage();
    const { manager, events } = launch(storage);
    // id() before start() must not bypass the cold-start path.
    const idBeforeReady = manager.id();
    expect(idBeforeReady).toMatch(UUID);
    expect(events).toHaveLength(0);
    await manager.start();
    expect(manager.id()).toBe(idBeforeReady);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("session.start");
    expect(events[0]!.attributes["session.id"]).toBe(manager.id());
    // Spec PRV-13: no user id until the app sets one; nothing anonymous is made up or persisted.
    expect(events[0]!.attributes["user.id"]).toBeUndefined();
    expect(manager.userId()).toBe("");
    expect(events[0]!.attributes["ouo.session.started_at"]).toBe(Date.now());
    expect(events[0]!.attributes["session.previous_id"]).toBeUndefined();
    expect(events[0]!.timestamp).toBe(Date.now());
    expect(persisted(storage).id).toBe(manager.id());
    expect(persisted(storage).userId).toBe("");
    expect(storage.peek(USER_STORAGE_KEY)).toBeNull();
  });

  it("case 2: re-init within the inactivity window (same process) resumes the session with no new event", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    const id = first.manager.id();
    first.manager.stop();

    vi.advanceTimersByTime(10 * MIN);
    const second = launch(storage, first.process);
    await second.manager.start();
    expect(second.manager.id()).toBe(id);
    expect(second.events).toHaveLength(0);
  });

  it("case 3: re-init after the inactivity window ends the old session (inactivity) and starts a new one with previous_id", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    const id = first.manager.id();
    const startedAt = Date.now();
    first.manager.stop();

    vi.advanceTimersByTime(INACTIVITY + 5 * MIN);
    const second = launch(storage, first.process);
    await second.manager.start();
    expect(second.manager.id()).not.toBe(id);
    expect(second.events.map((e) => e.name)).toEqual(["session.end", "session.start"]);
    const end = second.events[0]!;
    expect(end.attributes["session.id"]).toBe(id);
    expect(end.attributes["ouo.session.end_reason"]).toBe("inactivity");
    expect(end.attributes["ouo.session.ended_at"]).toBe(startedAt + INACTIVITY);
    expect(end.attributes["ouo.session.duration_ms"]).toBe(INACTIVITY);
    expect(end.timestamp).toBe(startedAt + INACTIVITY);
    const start = second.events[1]!;
    expect(start.attributes["session.id"]).toBe(second.manager.id());
    expect(start.attributes["session.previous_id"]).toBe(id);
    expect(second.manager.previousId()).toBe(id);
  });

  it("case 3 (cold start): a persisted session past the inactivity window ends with reason inactivity, not terminated", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    const id = first.manager.id();
    const startedAt = Date.now();
    vi.advanceTimersByTime(2 * MIN);
    first.manager.touch();
    first.manager.stop();

    vi.advanceTimersByTime(INACTIVITY + MIN);
    const second = launch(storage.clone(), {});
    await second.manager.start();
    expect(second.events.map((e) => e.name)).toEqual(["session.end", "session.start"]);
    expect(second.events[0]!.attributes["session.id"]).toBe(id);
    expect(second.events[0]!.attributes["ouo.session.end_reason"]).toBe("inactivity");
    expect(second.events[0]!.attributes["ouo.session.ended_at"]).toBe(startedAt + 2 * MIN + INACTIVITY);
    expect(second.events[1]!.attributes["session.previous_id"]).toBe(id);
  });

  it("case 4 (extra): activity after MAX_DURATION rotates the session (max_duration)", async () => {
    const storage = new MemoryAsyncStorage();
    const { manager, events } = launch(storage);
    await manager.start();
    const id = manager.id();
    const startedAt = Date.now();
    // Keep it active every 10 minutes so inactivity never triggers.
    for (let t = 0; t < MAX; t += 10 * MIN) {
      vi.advanceTimersByTime(10 * MIN);
      manager.touch();
    }
    expect(manager.id()).not.toBe(id);
    const end = events.find((e) => e.name === "session.end")!;
    expect(end.attributes["ouo.session.end_reason"]).toBe("max_duration");
    expect(end.attributes["ouo.session.ended_at"]).toBe(startedAt + MAX);
    expect(events.at(-1)!.attributes["session.previous_id"]).toBe(id);
  });

  it("case 5: background longer than BACKGROUND_TIMEOUT then foreground rotates the session (background)", async () => {
    const storage = new MemoryAsyncStorage();
    const { manager, events } = launch(storage);
    await manager.start();
    const id = manager.id();
    vi.advanceTimersByTime(MIN);
    manager.onBackground();
    const backgroundAt = Date.now();
    expect(persisted(storage).backgroundAt).toBe(backgroundAt);
    vi.advanceTimersByTime(BACKGROUND + 5 * SEC);
    manager.onForeground();
    expect(manager.id()).not.toBe(id);
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end", "session.start"]);
    const end = events[1]!;
    expect(end.attributes["session.id"]).toBe(id);
    expect(end.attributes["ouo.session.end_reason"]).toBe("background");
    expect(end.attributes["ouo.session.ended_at"]).toBe(backgroundAt + BACKGROUND);
    expect(events[2]!.attributes["session.previous_id"]).toBe(id);
    expect(persisted(storage).id).toBe(manager.id());
    expect(persisted(storage).backgroundAt).toBeUndefined();
  });

  it("case 5 (negative): a short background stay keeps the session", async () => {
    const storage = new MemoryAsyncStorage();
    const { manager, events } = launch(storage);
    await manager.start();
    const id = manager.id();
    manager.onBackground();
    vi.advanceTimersByTime(10 * SEC);
    manager.onForeground();
    expect(manager.id()).toBe(id);
    expect(events).toHaveLength(1);
    expect(persisted(storage).backgroundAt).toBeUndefined();
    expect(persisted(storage).lastActivity).toBe(Date.now());
  });

  it("case 5 (timer): the in-process timer ends a backgrounded session after the timeout and the next activity starts a new one", async () => {
    const storage = new MemoryAsyncStorage();
    const { manager, events } = launch(storage);
    await manager.start();
    const id = manager.id();
    manager.onBackground();
    vi.advanceTimersByTime(BACKGROUND + SEC);
    expect(events.map((e) => e.name)).toEqual(["session.start", "session.end"]);
    expect(events[1]!.attributes["ouo.session.end_reason"]).toBe("background");
    expect(manager.peek()).toBeNull();
    // No phantom session while still in background: created on the next activity only.
    manager.onForeground();
    expect(manager.id()).not.toBe(id);
    expect(events).toHaveLength(3);
  });

  it("case 6: the crash marker makes the next launch end the session with reason crash", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    const id = first.manager.id();
    vi.advanceTimersByTime(45 * SEC);
    await first.manager.markCrash({ type: "TypeError", message: "boom" });
    const crashAt = Date.now();
    expect(JSON.parse(storage.peek(CRASH_STORAGE_KEY)!)).toMatchObject({ sessionId: id, at: crashAt, type: "TypeError", message: "boom" });

    // Process died: new process memory, same disk.
    vi.advanceTimersByTime(20 * SEC);
    const second = launch(storage.clone(), {});
    const disk = (second.manager as unknown as { storage: MemoryAsyncStorage }).storage;
    await second.manager.start();
    expect(second.events.map((e) => e.name)).toEqual(["session.end", "session.start"]);
    const end = second.events[0]!;
    expect(end.attributes["session.id"]).toBe(id);
    expect(end.attributes["ouo.session.end_reason"]).toBe("crash");
    expect(end.attributes["ouo.session.ended_at"]).toBe(crashAt);
    expect(end.attributes["ouo.session.duration_ms"]).toBe(45 * SEC);
    expect(second.events[1]!.attributes["session.previous_id"]).toBe(id);
    expect(second.manager.id()).not.toBe(id);
    expect(disk.peek(CRASH_STORAGE_KEY)).toBeNull();
    expect(persisted(disk).id).toBe(second.manager.id());
  });

  it("cold start without a crash marker ends the previous session with reason terminated", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    const id = first.manager.id();
    vi.advanceTimersByTime(2 * MIN);
    first.manager.touch();
    const lastActivity = Date.now();
    first.manager.stop();

    vi.advanceTimersByTime(5 * MIN);
    // The app was updated in between: the end event still names the version the session ran on.
    const second = launch(storage.clone(), {}, { serviceVersion: "2.4.0" });
    await second.manager.start();
    expect(second.events.map((e) => e.name)).toEqual(["session.end", "session.start"]);
    expect(second.events[0]!.attributes["ouo.session.end_reason"]).toBe("terminated");
    expect(second.events[0]!.attributes["ouo.session.ended_at"]).toBe(lastActivity);
    expect(second.events[0]!.attributes["service.version"]).toBe("2.3.0");
    expect(second.events[1]!.attributes["session.previous_id"]).toBe(id);
  });

  it("cold start after a kill while backgrounded ends the previous session with reason background", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    first.manager.onBackground();
    const backgroundAt = Date.now();
    first.manager.stop(); // process killed: no in-process timer fires
    vi.advanceTimersByTime(5 * MIN);
    const second = launch(storage.clone(), {});
    await second.manager.start();
    expect(second.events[0]!.attributes["ouo.session.end_reason"]).toBe("background");
    expect(second.events[0]!.attributes["ouo.session.ended_at"]).toBe(backgroundAt + BACKGROUND);
  });

  it("cold start after a session that already ended in the previous run only sets previous_id", async () => {
    const storage = new MemoryAsyncStorage();
    const first = launch(storage);
    await first.manager.start();
    const id = first.manager.id();
    first.manager.onBackground();
    vi.advanceTimersByTime(BACKGROUND + SEC); // timer ends it, marker persisted as ended
    expect(persisted(storage).endedAt).toBeDefined();
    const second = launch(storage.clone(), {});
    await second.manager.start();
    expect(second.events.map((e) => e.name)).toEqual(["session.start"]);
    expect(second.events[0]!.attributes["session.previous_id"]).toBe(id);
  });

  it("has no user id until setUser (PRV-13); a set user persists across launches; clearUser removes it; an old anonymous id is dropped", async () => {
    const storage = new MemoryAsyncStorage();
    // An anonymous id written by an older SDK version.
    await storage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: "anon-from-0.3.0", anonymous: true }));
    const first = launch(storage);
    await first.manager.start();
    expect(first.manager.userId()).toBe("");
    expect(storage.peek(USER_STORAGE_KEY)).toBeNull();
    const disk2 = storage.clone();
    const second = launch(disk2, {});
    await second.manager.start();
    expect(second.manager.userId()).toBe("");
    expect(second.events[1]!.attributes["user.id"]).toBeUndefined();

    second.manager.setUser("user-42");
    expect(second.manager.userId()).toBe("user-42");
    expect(JSON.parse(disk2.peek(USER_STORAGE_KEY)!)).toEqual({ id: "user-42", anonymous: false });
    // The next launch, without a user at init, still knows the user that was set.
    const relaunch = launch(disk2.clone(), {});
    await relaunch.manager.start();
    expect(relaunch.manager.userId()).toBe("user-42");
    relaunch.manager.clearUser();
    expect(relaunch.manager.userId()).toBe("");
    const third = launch(disk2.clone(), {}, { initialUserId: "user-42" });
    await third.manager.start();
    expect(third.manager.userId()).toBe("user-42");
    expect(third.events[0]!.attributes["user.id"]).toBe("user-42");
  });

  // Spec SES-6: at most once per 5 s (it was once per second).
  it("persists activity at most once per 5 s and immediately on structural changes", async () => {
    const storage = new MemoryAsyncStorage();
    const spy = vi.spyOn(storage, "setItem");
    const { manager } = launch(storage);
    await manager.start();
    spy.mockClear();
    manager.touch();
    manager.touch();
    vi.advanceTimersByTime(4500);
    manager.touch();
    expect(spy.mock.calls.filter((c) => c[0] === SESSION_STORAGE_KEY)).toHaveLength(0);
    vi.advanceTimersByTime(600);
    manager.touch();
    expect(spy.mock.calls.filter((c) => c[0] === SESSION_STORAGE_KEY)).toHaveLength(1);
    expect(persisted(storage).lastActivity).toBe(Date.now());
  });

  it("ignores corrupt persisted state", async () => {
    const storage = new MemoryAsyncStorage();
    await storage.setItem(SESSION_STORAGE_KEY, "{not json");
    await storage.setItem(CRASH_STORAGE_KEY, "42");
    const { manager, events } = launch(storage);
    await manager.start();
    expect(events.map((e) => e.name)).toEqual(["session.start"]);
    expect(manager.id()).toMatch(UUID);
  });
});
