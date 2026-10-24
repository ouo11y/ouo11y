/**
 * Session rotation on user change, `endSession`, `clearUser` and `device.id`
 * (docs/specs/session-lifecycle.md, "User and device").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeviceId, DEVICE_STORAGE_KEY } from "../src/session/device";
import { SessionManager, USER_STORAGE_KEY, type SessionEvent } from "../src/session/manager";
import { LocalStorage, MemoryStorage } from "../src/session/storage";

/** Every event with the user the session reported while it was emitted. */
type Seen = SessionEvent & { user: string };

function make(storage: MemoryStorage, seen: Seen[], opts: { initialUserId?: string; deviceId?: string } = {}) {
  const m: SessionManager = new SessionManager({
    storage,
    onEvent: (e) => seen.push({ ...e, user: m.userId() }),
    ...(opts.initialUserId ? { initialUserId: opts.initialUserId } : {}),
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
  });
  return m;
}
const names = (seen: Seen[]) => seen.map((e) => `${e.name}${e.attributes["ouo.session.end_reason"] ? `:${e.attributes["ouo.session.end_reason"]}` : ""}`);

describe("user change", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
  });

  it("anonymous to identified (a login) keeps the session", () => {
    const seen: Seen[] = [];
    const m = make(new MemoryStorage(), seen);
    m.start();
    const id = m.id();
    m.setUser("u-1");
    expect(m.id()).toBe(id);
    expect(m.userId()).toBe("u-1");
    expect(m.isAnonymousUser()).toBe(false);
    expect(names(seen)).toEqual(["session.start"]);
  });

  it("the same id again changes nothing", () => {
    const seen: Seen[] = [];
    const m = make(new MemoryStorage(), seen);
    m.start();
    m.setUser("u-1");
    m.setUser("u-1");
    expect(names(seen)).toEqual(["session.start"]);
  });

  it("one identified user to another ends the session (user_change) and starts a linked one", () => {
    const seen: Seen[] = [];
    const m = make(new MemoryStorage(), seen);
    m.start();
    m.setUser("u-1");
    const first = m.id();
    vi.advanceTimersByTime(5000);
    m.setUser("u-2");
    expect(names(seen)).toEqual(["session.start", "session.end:user_change", "session.start"]);
    const [, end, start] = seen;
    // The end belongs to the previous user, the new session to the new one.
    expect(end!.user).toBe("u-1");
    expect(end!.attributes["session.id"]).toBe(first);
    expect(end!.attributes["ouo.session.duration_ms"]).toBe(5000);
    expect(start!.user).toBe("u-2");
    expect(start!.attributes["session.previous_id"]).toBe(first);
    expect(m.id()).not.toBe(first);
  });

  it("clearUser (logout) goes back to a fresh anonymous id in a new session", () => {
    const storage = new MemoryStorage();
    const seen: Seen[] = [];
    const m = make(storage, seen);
    m.start();
    const anonymous = m.userId();
    m.setUser("u-1");
    const first = m.id();
    m.clearUser();
    expect(m.isAnonymousUser()).toBe(true);
    expect(m.userId()).not.toBe("u-1");
    expect(m.userId()).not.toBe(anonymous);
    expect(m.id()).not.toBe(first);
    expect(names(seen)).toEqual(["session.start", "session.end:user_change", "session.start"]);
    expect(seen[1]!.user).toBe("u-1");
    expect(JSON.parse(storage.get(USER_STORAGE_KEY)!)).toEqual({ id: m.userId(), anonymous: true });
  });

  it("user.id in the options that differs from the resumed session's identified user rotates it", () => {
    const storage = new MemoryStorage();
    const seen: Seen[] = [];
    const a = make(storage, seen, { initialUserId: "u-1" });
    a.start();
    const first = a.id();
    a.stop();
    // A reload with another user configured (an account switch between page loads).
    const b = make(storage, seen, { initialUserId: "u-2" });
    b.start();
    expect(names(seen)).toEqual(["session.start", "session.end:user_change", "session.start"]);
    expect(seen[1]!.attributes["session.id"]).toBe(first);
    expect(seen[1]!.user).toBe("u-1");
    expect(b.userId()).toBe("u-2");
  });

  it("user.id in the options with an anonymous resumed session keeps the session", () => {
    const storage = new MemoryStorage();
    const seen: Seen[] = [];
    const a = make(storage, seen);
    a.start();
    const first = a.id();
    a.stop();
    const b = make(storage, seen, { initialUserId: "u-1" });
    b.start();
    expect(b.id()).toBe(first);
    expect(b.userId()).toBe("u-1");
    expect(names(seen)).toEqual(["session.start"]);
  });
});

describe("endSession", () => {
  it("emits session.end (manual) and the next signal starts a linked session", () => {
    const seen: Seen[] = [];
    const m = make(new MemoryStorage(), seen);
    m.start();
    const first = m.id();
    m.endSession();
    expect(names(seen)).toEqual(["session.start", "session.end:manual"]);
    expect(m.peek()).toBeNull();
    m.touch();
    expect(names(seen)).toEqual(["session.start", "session.end:manual", "session.start"]);
    expect(seen[2]!.attributes["session.previous_id"]).toBe(first);
    // Twice in a row: the second has nothing to end.
    m.endSession();
    m.endSession();
    expect(names(seen).filter((n) => n === "session.end:manual")).toHaveLength(2);
  });
});

describe("device.id", () => {
  it("is generated once, persisted under its own key and outlives sessions and users", () => {
    const storage = new MemoryStorage();
    const device = loadDeviceId(storage);
    expect(device).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(storage.get(DEVICE_STORAGE_KEY)!)).toEqual({ id: device });
    const seen: Seen[] = [];
    const m = make(storage, seen, { deviceId: loadDeviceId(storage) });
    m.start();
    m.setUser("u-1");
    m.clearUser();
    m.endSession();
    m.touch();
    expect(loadDeviceId(storage)).toBe(device);
    expect(seen.every((e) => e.attributes["device.id"] === device)).toBe(true);
    expect(seen).toHaveLength(5);
  });

  it("replaces a corrupt value", () => {
    const storage = new MemoryStorage();
    storage.set(DEVICE_STORAGE_KEY, "{");
    const id = loadDeviceId(storage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadDeviceId(storage)).toBe(id);
  });

  it("lives in memory for the page when storage is blocked", () => {
    const storage = new LocalStorage(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const id = loadDeviceId(storage);
    expect(loadDeviceId(storage)).toBe(id);
  });
});
