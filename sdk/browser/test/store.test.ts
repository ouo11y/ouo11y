/** The offline store: IndexedDB (fake-indexeddb here, real browsers in e2e/delivery.spec.ts) and its memory fallback. */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createLogger, type DebugLogger } from "../src/logger";
import { IdbStore, MemoryStore, openDatabase, ResilientStore, type StoredRequest } from "../src/transport/store";

const entry = (bytes: number, n = 0): StoredRequest => ({
  url: "http://c.test/v1/traces",
  headers: { Authorization: "Basic eDp5", "content-type": "application/json" },
  body: new Uint8Array(bytes).fill(n),
  createdAt: 1000 + n,
  notBefore: 0,
  attempts: 0,
});

function warnings(): DebugLogger & { warns: string[] } {
  const warns: string[] = [];
  return { enabled: true, log: () => undefined, warn: (...a: unknown[]) => void warns.push(a.map(String).join(" ")), warns };
}

describe("IdbStore", () => {
  it("keeps requests across connections (the next page load) and returns them oldest first", async () => {
    const factory = new IDBFactory();
    const first = new IdbStore(await openDatabase(factory), 10_000);
    await first.put(entry(10, 1));
    await first.put(entry(20, 2));
    const next = new IdbStore(await openDatabase(factory), 10_000);
    const got = await next.oldest(10);
    expect(got.map((e) => e.body.byteLength)).toEqual([10, 20]);
    expect(got[0]!.headers["Authorization"]).toBe("Basic eDp5");
    expect(ArrayBuffer.isView(got[0]!.body)).toBe(true);
    await next.update({ ...got[0]!, attempts: 3, notBefore: 99 });
    await next.delete(got[1]!.id!);
    const left = await next.oldest(10);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ attempts: 3, notBefore: 99 });
  });

  it("evicts the oldest entries beyond the byte cap, never the new one, and refuses one larger than the cap", async () => {
    const s = new IdbStore(await openDatabase(new IDBFactory()), 2500);
    expect((await s.put(entry(1000, 1))).evicted).toEqual([]);
    expect((await s.put(entry(1000, 2))).evicted).toEqual([]);
    const third = await s.put(entry(1000, 3));
    expect(third.evicted).toEqual([1000]);
    expect((await s.oldest(10)).map((e) => e.body[0])).toEqual([2, 3]);
    expect(await s.put(entry(3000, 4))).toEqual({ id: null, evicted: [] });
  });

  it("limits a read", async () => {
    const s = new IdbStore(await openDatabase(new IDBFactory()), 1 << 20);
    for (let i = 0; i < 5; i++) await s.put(entry(1, i));
    expect((await s.oldest(2)).map((e) => e.body[0])).toEqual([0, 1]);
  });
});

describe("ResilientStore", () => {
  it("uses IndexedDB when it opens", async () => {
    const s = new ResilientStore({ maxBytes: 1000, logger: createLogger(false), factory: new IDBFactory() });
    await s.ready();
    expect(s.kind).toBe("indexeddb");
    const { id } = await s.put(entry(10));
    expect(id).toBeGreaterThan(0);
    expect(await s.oldest(5)).toHaveLength(1);
    await s.delete(id!);
    expect(await s.oldest(5)).toHaveLength(0);
  });

  it("falls back to memory without IndexedDB (jsdom, blocked storage)", async () => {
    const s = new ResilientStore({ maxBytes: 1000, logger: createLogger(false), factory: null });
    expect(s.kind).toBe("memory");
    const { id } = await s.put(entry(10));
    expect(id).toBeLessThan(0);
    const [e] = await s.oldest(5);
    await s.update({ ...e!, attempts: 2 });
    expect((await s.oldest(5))[0]!.attempts).toBe(2);
    await s.delete(e!.id!);
    expect(await s.oldest(5)).toHaveLength(0);
  });

  it("falls back to memory when open throws (private mode) or is blocked, and never throws itself", async () => {
    const throwing = { open: () => { throw new DOMException("denied", "SecurityError"); } } as unknown as IDBFactory;
    const blocked = {
      open: () => {
        const req = {} as IDBOpenDBRequest;
        setTimeout(() => (req.onblocked as (() => void) | null)?.(), 0);
        return req;
      },
    } as unknown as IDBFactory;
    for (const factory of [throwing, blocked]) {
      const logger = warnings();
      const s = new ResilientStore({ maxBytes: 1000, logger, factory });
      await s.ready();
      expect(s.kind).toBe("memory");
      expect((await s.put(entry(10))).id).not.toBeNull();
      expect(await s.oldest(5)).toHaveLength(1);
      expect(logger.warns.join()).toContain("IndexedDB unavailable");
    }
  });

  it("keeps an entry in memory when the disk is full, and stays on IndexedDB", async () => {
    const factory = new IDBFactory();
    const s = new ResilientStore({ maxBytes: 1000, logger: createLogger(false), factory });
    await s.ready();
    const idb = await (s as unknown as { idb: Promise<IdbStore> }).idb;
    const put = idb.put.bind(idb);
    idb.put = () => Promise.reject(new DOMException("full", "QuotaExceededError"));
    expect((await s.put(entry(10))).id).toBeLessThan(0);
    expect(s.kind).toBe("indexeddb");
    idb.put = put;
    expect((await s.put(entry(10))).id).toBeGreaterThan(0);
  });
});

describe("MemoryStore", () => {
  it("evicts oldest first", async () => {
    const s = new MemoryStore(25);
    for (let i = 0; i < 4; i++) await s.put(entry(10, i));
    expect((await s.oldest(10)).map((e) => e.body[0])).toEqual([2, 3]);
  });
});
