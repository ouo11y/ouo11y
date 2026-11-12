/** Sessions (SDK spec section 5), driven by a fake clock over a shared in-memory `localStorage`. */
import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/core/clock";
import { PERSIST_EVERY_MS, SESSION_KEY, SessionManager, type EndReason, type SessionRecord } from "../src/session/manager";
import { ConsentStorage, MemoryStorage } from "../src/session/storage";

class FakeClock implements Clock {
  t = 1_700_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.set(this.next, { at: this.t + ms, fn });
    return this.next++;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

const MIN = 60_000;

function tab(storage: MemoryStorage, clock: FakeClock, o: { rate?: number; inactivity?: number; max?: number } = {}) {
  const log: string[] = [];
  const starts: SessionRecord[] = [];
  const ends: Array<{ rec: SessionRecord; reason: EndReason }> = [];
  let held = 0;
  const m = new SessionManager({
    storage,
    clock,
    locks: null,
    inactivityTimeoutMs: o.inactivity ?? 30 * MIN,
    maxDurationMs: o.max ?? 240 * MIN,
    sessionRate: o.rate ?? 1,
    hooks: {
      onStart: (rec) => {
        starts.push({ ...rec });
        log.push(`start ${rec.id}`);
      },
      onEnd: (rec, reason) => {
        ends.push({ rec: { ...rec }, reason });
        log.push(`end ${rec.id} ${reason}`);
      },
      onChange: () => undefined,
      hold: () => held++,
      release: () => held--,
      restamp: () => undefined,
    },
  });
  return { m, log, starts, ends, held: () => held };
}

let storage: MemoryStorage;
let clock: FakeClock;
beforeEach(() => {
  storage = new MemoryStorage();
  clock = new FakeClock();
});

describe("start and activity (SES-3, SES-5, SES-10)", () => {
  it("a visible init starts a session; a hidden one waits for activity", () => {
    const hidden = tab(storage, clock);
    hidden.m.start(false);
    expect(hidden.m.id()).toBeUndefined();
    expect(hidden.starts).toHaveLength(0);
    hidden.m.activity();
    expect(hidden.m.id()).toMatch(/^[0-9a-f]{32}$/);
    expect(hidden.starts).toHaveLength(1);
    expect(hidden.held()).toBe(0);
  });

  it("asking for a stamp never creates a session: a polling tab makes none", () => {
    const t = tab(storage, clock);
    t.m.start(false);
    for (let i = 0; i < 5; i++) {
      const s = t.m.stamp();
      expect(s.expired).toBe(true);
      clock.advance(MIN);
    }
    expect(storage.get(SESSION_KEY)).toBeNull();
    expect(t.starts).toHaveLength(0);
    // The made-up id for bypass records is stable for the page.
    expect(t.m.stamp().id).toBe(t.m.stamp().id);
  });

  it("stamps do not extend the session, activity does", () => {
    const t = tab(storage, clock, { inactivity: 10 * MIN });
    t.m.start(true);
    const id = t.m.id()!;
    clock.advance(6 * MIN);
    t.m.stamp();
    clock.advance(6 * MIN);
    expect(t.m.stamp().expired).toBe(true);
    expect(t.ends.map((e) => e.reason)).toEqual(["timeout"]);
    // The expired stamp names the last session.
    expect(t.m.stamp().id).toBe(id);

    const u = tab(new MemoryStorage(), clock, { inactivity: 10 * MIN });
    u.m.start(true);
    clock.advance(6 * MIN);
    u.m.activity();
    clock.advance(6 * MIN);
    expect(u.m.stamp().expired).toBe(false);
  });
});

describe("end and rollover (SES-4, SES-7, SES-9)", () => {
  it("activity after the timeout ends the old session at its last activity and starts a linked one", () => {
    const t = tab(storage, clock, { inactivity: 10 * MIN });
    t.m.start(true);
    const first = t.m.id()!;
    clock.advance(3 * MIN);
    t.m.activity();
    const lastActivity = clock.now();
    clock.advance(9 * MIN);
    // Not yet expired by the timer margin; the user comes back after the timeout.
    clock.advance(2 * MIN);
    t.m.activity();
    const second = t.m.id()!;
    expect(second).not.toBe(first);
    expect(t.log).toEqual([`start ${first}`, `end ${first} timeout`, `start ${second}`]);
    expect(t.ends[0]!.rec.last).toBe(lastActivity);
    expect(t.starts[1]!.prev).toBe(first);
    expect(t.starts[0]!.prev).toBeUndefined();
  });

  it("an idle page ends the session once, by its timer", () => {
    const t = tab(storage, clock, { inactivity: 10 * MIN });
    t.m.start(true);
    const id = t.m.id()!;
    clock.advance(11 * MIN);
    expect(t.log).toEqual([`start ${id}`, `end ${id} timeout`]);
    clock.advance(60 * MIN);
    expect(t.ends).toHaveLength(1);
  });

  it("reaching the maximum duration with the user present rolls at once", () => {
    const t = tab(storage, clock, { inactivity: 30 * MIN, max: 60 * MIN });
    t.m.start(true);
    const first = t.m.id()!;
    for (let i = 0; i < 12; i++) {
      clock.advance(5 * MIN - 1);
      t.m.activity();
    }
    expect(t.m.id()).toBe(first);
    clock.advance(2 * MIN);
    t.m.activity();
    const second = t.m.id()!;
    expect(second).not.toBe(first);
    expect(t.ends.map((e) => e.reason)).toEqual(["max_duration"]);
    expect(t.starts[1]!.prev).toBe(first);
  });

  it("restart ends with `manual` and starts the next one now; end leaves none", () => {
    const t = tab(storage, clock);
    t.m.start(true);
    const first = t.m.id()!;
    t.m.restart();
    expect(t.m.id()).not.toBe(first);
    expect(t.ends.map((e) => e.reason)).toEqual(["manual"]);
    t.m.end("shutdown");
    expect(t.m.id()).toBeUndefined();
    expect(t.ends.map((e) => e.reason)).toEqual(["manual", "shutdown"]);
    t.m.end("shutdown");
    expect(t.ends).toHaveLength(2);
  });

  it("after consent is withdrawn the next session names no previous one (PRV-4)", () => {
    const t = tab(storage, clock);
    t.m.start(true);
    t.m.end("consent");
    t.m.sever();
    expect(storage.get(SESSION_KEY)).toBeNull();
    t.m.activity();
    expect(t.starts[1]!.prev).toBeUndefined();
  });
});

describe("tabs (SES-11) and persistence (SES-6, SMP-1)", () => {
  it("two tabs share one session and emit one start", () => {
    const a = tab(storage, clock);
    const b = tab(storage, clock);
    a.m.start(true);
    b.m.start(true);
    expect(b.m.id()).toBe(a.m.id());
    expect(a.starts.length + b.starts.length).toBe(1);
  });

  it("a second tab keeps the session alive for the first, and only one tab ends it", () => {
    const a = tab(storage, clock, { inactivity: 10 * MIN });
    const b = tab(storage, clock, { inactivity: 10 * MIN });
    a.m.start(true);
    b.m.start(true);
    const id = a.m.id()!;
    clock.advance(8 * MIN);
    b.m.activity();
    b.m.persist();
    clock.advance(5 * MIN);
    // Tab A was idle for 13 minutes, but the session is alive through tab B.
    expect(a.m.stamp()).toMatchObject({ id, expired: false });
    clock.advance(20 * MIN);
    expect(a.ends.length + b.ends.length).toBe(1);
    // Whoever comes back first starts the next one; the other adopts it.
    a.m.activity();
    b.m.handleStorage(storage.get(SESSION_KEY));
    expect(b.m.id()).toBe(a.m.id());
    expect(a.starts.length + b.starts.length).toBe(2);
    expect(a.ends.length + b.ends.length).toBe(1);
  });

  it("a reload continues the stored session without a new start", () => {
    const a = tab(storage, clock);
    a.m.start(true);
    const id = a.m.id();
    a.m.persist();
    a.m.stop();
    clock.advance(MIN);
    const b = tab(storage, clock);
    b.m.start(true);
    expect(b.m.id()).toBe(id);
    expect(b.starts).toHaveLength(0);
  });

  it("writes last activity at most once per 5 s", () => {
    let writes = 0;
    const counting = new (class extends MemoryStorage {
      override set(k: string, v: string): void {
        writes++;
        super.set(k, v);
      }
    })();
    const t = tab(counting, clock);
    t.m.start(true);
    const before = writes;
    for (let i = 0; i < 100; i++) {
      clock.advance(100);
      t.m.activity();
    }
    expect(writes - before).toBe(Math.floor((100 * 100) / PERSIST_EVERY_MS));
  });

  it("the sampling decision is made once from the id and stored with the session", () => {
    const a = tab(storage, clock, { rate: 0.5 });
    a.m.start(true);
    const rec = JSON.parse(storage.get(SESSION_KEY)!) as SessionRecord;
    expect(rec.s).toBe(parseInt(rec.id.slice(0, 8), 16) / 2 ** 32 < 0.5);
    expect(rec.rate).toBe(0.5);
    // Another tab with another configured rate still follows the stored decision.
    const b = tab(storage, clock, { rate: rec.s ? 0 : 1 });
    b.m.start(true);
    expect(b.m.stamp().sampled).toBe(rec.s);
  });

  it("garbage or another version in storage is discarded, never a crash (GR-UPG-1)", () => {
    for (const raw of ["{", "null", '{"v":2,"id":"x"}', '{"v":1,"id":"not-hex","start":1,"last":1,"s":true}', "[]"]) {
      storage.set(SESSION_KEY, raw);
      const t = tab(storage, clock);
      expect(() => t.m.start(true)).not.toThrow();
      expect(t.m.id()).toMatch(/^[0-9a-f]{32}$/);
      storage.remove(SESSION_KEY);
    }
  });
});

describe("users (PRV-13)", () => {
  it("no user until setUser; a different user starts a new session; null clears", () => {
    const t = tab(storage, clock);
    t.m.start(true);
    const first = t.m.id()!;
    expect(t.m.stamp().user).toBeUndefined();
    t.m.setUser("u-1");
    expect(t.m.stamp()).toMatchObject({ id: first, user: "u-1" });
    t.m.setUser("u-1");
    expect(t.m.id()).toBe(first);
    t.m.setUser("u-2");
    expect(t.m.id()).not.toBe(first);
    expect(t.m.stamp().user).toBe("u-2");
    t.m.setUser(null);
    expect(t.m.stamp().user).toBeUndefined();
  });
});

describe("consent storage (PRV-1, PRV-4, SES-12)", () => {
  it("stays in memory until granted, moves to localStorage, and forgets on withdrawal", () => {
    localStorage.clear();
    const s = new ConsentStorage(false);
    s.set("ouo.session", "x");
    expect(localStorage.getItem("ouo.session")).toBeNull();
    expect(s.get("ouo.session")).toBe("x");
    s.persist();
    expect(localStorage.getItem("ouo.session")).toBe("x");
    localStorage.setItem("app.key", "keep");
    s.forget();
    expect(localStorage.getItem("ouo.session")).toBeNull();
    expect(localStorage.getItem("app.key")).toBe("keep");
    expect(s.get("ouo.session")).toBeNull();
    expect(document.cookie).toBe("");
  });

  it("blocked storage falls back to memory", () => {
    const s = new ConsentStorage(true, () => {
      throw new DOMException("denied", "SecurityError");
    });
    s.set("ouo.session", "x");
    expect(s.get("ouo.session")).toBe("x");
    expect(s.persistent()).toBe(false);
  });
});
