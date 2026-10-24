/**
 * Web Storage that is full, blocked or throwing falls back to memory without throwing
 * (checklist N42), and never mixes the two stores.
 */
import { describe, expect, it } from "vitest";
import { LocalStorage } from "../src/session/storage";
import { SessionManager } from "../src/session/manager";

/** A Storage whose methods fail on demand. */
function flaky(fail: { get?: boolean; set?: boolean } = {}): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const quota = (): never => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => (fail.get ? quota() : (data.get(k) ?? null)),
    setItem: (k: string, v: string) => (fail.set ? quota() : void data.set(k, v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

describe("LocalStorage fallback", () => {
  it("uses the platform store while it works", () => {
    const area = flaky();
    const s = new LocalStorage(() => area);
    s.set("ouo.a", "1");
    expect(area.data.get("ouo.a")).toBe("1");
    expect(s.get("ouo.a")).toBe("1");
    expect(s.inMemory()).toBe(false);
  });

  it("a getter that throws (sandboxed or third-party iframe) means memory from the start", () => {
    const s = new LocalStorage(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    expect(s.inMemory()).toBe(true);
    s.set("ouo.a", "1");
    expect(s.get("ouo.a")).toBe("1");
    s.remove("ouo.a");
    expect(s.get("ouo.a")).toBeNull();
  });

  it("no storage at all (null) is memory", () => {
    const s = new LocalStorage(() => null);
    s.set("k", "v");
    expect(s.get("k")).toBe("v");
  });

  it("a full store (quota at 0, as Safari private mode had) is detected by the probe", () => {
    const s = new LocalStorage(() => flaky({ set: true }));
    expect(s.inMemory()).toBe(true);
  });

  it("a store that fills up later switches to memory with the ouo keys it had, and never reads the stale copy", () => {
    const area = flaky();
    const s = new LocalStorage(() => area);
    s.set("ouo.session", "v1");
    s.set("ouo.user", "u1");
    area.data.set("app.key", "not ours");
    // The store fills up: writes fail, reads still work.
    area.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    s.set("ouo.session", "v2");
    expect(s.inMemory()).toBe(true);
    expect(s.get("ouo.session")).toBe("v2"); // not the stale v1 still in the platform store
    expect(s.get("ouo.user")).toBe("u1"); // copied over
    expect(s.get("app.key")).toBeNull(); // only the SDK's keys
  });

  it("a session manager on a broken store keeps one session for the page", () => {
    const events: string[] = [];
    const m = new SessionManager({
      storage: new LocalStorage(() => flaky({ get: true, set: true })),
      onEvent: (e) => events.push(e.name),
    });
    m.start();
    const id = m.id();
    m.touch();
    expect(m.id()).toBe(id);
    expect(events).toEqual(["session.start"]);
    m.stop();
  });
});
