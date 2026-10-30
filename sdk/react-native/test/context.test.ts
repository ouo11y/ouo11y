import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_PERSIST_DELAY_MS, CONTEXT_STORAGE_KEY, ContextPersister, parseScreenContext } from "../src/errors/context";
import type { SdkLogRecord } from "@opentelemetry/sdk-logs";

const record = (name: string) => ({ attributes: { "event.name": name } }) as unknown as SdkLogRecord;

describe("ContextPersister (error context, review round 1)", () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    const writes: string[] = [];
    const storage = { getItem: async () => null, setItem: async (_k: string, v: string) => void writes.push(v), removeItem: async () => {} };
    let events = 0;
    const p = new ContextPersister(storage, () => ({ sessionId: "s", screen: "Cart", events: Array.from({ length: events }, (_, i) => ({ ts: i, name: "e", body: "" })) }));
    return { p, writes, add: () => events++, storage };
  }

  it("persists at once after a tap, a navigation or an exception", () => {
    const { p, writes, add } = setup();
    for (const name of ["ui.tap", "navigation", "exception"]) {
      add();
      p.onEmit(record(name));
    }
    expect(writes).toHaveLength(3);
    expect(parseScreenContext(writes[2]!)).toMatchObject({ sessionId: "s", screen: "Cart" });
  });

  it("other records at most every 5 s, trailing; background and flush at once; no write when nothing changed", async () => {
    const { p, writes, add } = setup();
    add();
    p.onEmit(record("log"));
    add();
    p.onEmit(record("http.request"));
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(CONTEXT_PERSIST_DELAY_MS - 1);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
    add();
    p.onEmit(record("app.jank"));
    p.persistNow(); // background
    expect(writes).toHaveLength(2);
    await p.forceFlush(); // nothing new
    expect(writes).toHaveLength(2);
    vi.advanceTimersByTime(CONTEXT_PERSIST_DELAY_MS);
    expect(writes).toHaveLength(2);
    expect(CONTEXT_STORAGE_KEY).toBe("ouo.context");
  });
});
