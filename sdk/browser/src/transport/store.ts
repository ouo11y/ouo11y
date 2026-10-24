import type { DebugLogger } from "../logger";

/**
 * Requests kept for later: offline, after the retries ran out, or at page hide beyond the
 * keepalive budget. IndexedDB when it works (one database per origin, shared by its tabs, so the
 * next page load sends what this one could not), memory otherwise. Bounded by a byte cap with
 * oldest-first eviction. No method rejects: a storage failure costs the entry, never the page.
 */
export interface StoredRequest {
  id?: number;
  url: string;
  /** Request headers, `Authorization` included (the public project credential, ADR-0007). */
  headers: Record<string, string>;
  /** Uncompressed body. */
  body: Uint8Array;
  createdAt: number;
  /** Not sent again before this time (a long `Retry-After`). */
  notBefore: number;
  attempts: number;
}

export interface PutResult {
  /** The new entry's id, or null when it was not kept (larger than the cap, or storage failed). */
  id: number | null;
  /** Byte sizes of the older entries evicted to make room. */
  evicted: number[];
}

export interface OfflineStore {
  readonly kind: "indexeddb" | "memory";
  put(entry: StoredRequest): Promise<PutResult>;
  /** Up to `limit` entries, oldest first. */
  oldest(limit: number): Promise<StoredRequest[]>;
  /** Saves `attempts` and `notBefore` of an entry read with {@link oldest}. */
  update(entry: StoredRequest): Promise<void>;
  delete(id: number): Promise<void>;
}

type Meta = Omit<StoredRequest, "body"> & { id: number; bytes: number };

/** Oldest-first ids to evict so `total` fits in `cap`; `keep` is never evicted. */
function toEvict(metas: Array<{ id: number; bytes: number }>, cap: number, keep: number): Array<{ id: number; bytes: number }> {
  let total = metas.reduce((n, m) => n + m.bytes, 0);
  const out: Array<{ id: number; bytes: number }> = [];
  for (const m of [...metas].sort((a, b) => a.id - b.id)) {
    if (total <= cap) break;
    if (m.id === keep) continue;
    out.push(m);
    total -= m.bytes;
  }
  return out;
}

export class MemoryStore implements OfflineStore {
  readonly kind = "memory" as const;
  private readonly entries = new Map<number, StoredRequest & { id: number }>();
  private nextId = 1;

  constructor(private readonly maxBytes: number) {}

  async put(entry: StoredRequest): Promise<PutResult> {
    if (entry.body.byteLength > this.maxBytes) return { id: null, evicted: [] };
    const id = this.nextId++;
    this.entries.set(id, { ...entry, id });
    const evict = toEvict([...this.entries.values()].map((e) => ({ id: e.id, bytes: e.body.byteLength })), this.maxBytes, id);
    for (const m of evict) this.entries.delete(m.id);
    return { id, evicted: evict.map((m) => m.bytes) };
  }

  async oldest(limit: number): Promise<StoredRequest[]> {
    return [...this.entries.values()].sort((a, b) => a.id - b.id).slice(0, limit).map((e) => ({ ...e }));
  }

  async update(entry: StoredRequest): Promise<void> {
    const cur = entry.id === undefined ? undefined : this.entries.get(entry.id);
    if (cur) Object.assign(cur, { attempts: entry.attempts, notBefore: entry.notBefore });
  }

  async delete(id: number): Promise<void> {
    this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }
}

export const IDB_NAME = "ouo-delivery";
const META = "meta";
const BODY = "body";

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** Opens the delivery database; rejects on error, on a blocked upgrade, or after `timeoutMs` (Safari can hang). */
export function openDatabase(factory: IDBFactory, name = IDB_NAME, timeoutMs = 3000): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("indexedDB open timed out")), timeoutMs);
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, 1);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains(BODY)) db.createObjectStore(BODY);
    };
    req.onsuccess = () =>
      finish(() => {
        const db = req.result;
        // A newer SDK in another tab upgrading the schema: step aside rather than block it.
        db.onversionchange = () => db.close();
        resolve(db);
      });
    req.onerror = () => finish(() => reject(req.error));
    req.onblocked = () => finish(() => reject(new Error("indexedDB open blocked")));
  });
}

/** Metadata and bodies in two object stores so the cap is enforced without reading bodies. */
export class IdbStore implements OfflineStore {
  readonly kind = "indexeddb" as const;

  constructor(
    private readonly db: IDBDatabase,
    private readonly maxBytes: number,
  ) {}

  async put(entry: StoredRequest): Promise<PutResult> {
    const bytes = entry.body.byteLength;
    if (bytes > this.maxBytes) return { id: null, evicted: [] };
    const tx = this.db.transaction([META, BODY], "readwrite");
    const metas = tx.objectStore(META);
    const bodies = tx.objectStore(BODY);
    const { body, id: _ignored, ...rest } = entry;
    let id: number | null = null;
    const evicted: number[] = [];
    // One transaction: tabs writing at once cannot together exceed the cap.
    const add = metas.add({ ...rest, bytes });
    add.onsuccess = () => {
      id = add.result as number;
      bodies.put(body, id);
      const all = metas.getAll();
      all.onsuccess = () => {
        for (const m of toEvict(all.result as Meta[], this.maxBytes, id!)) {
          metas.delete(m.id);
          bodies.delete(m.id);
          evicted.push(m.bytes);
        }
      };
    };
    await done(tx);
    return { id, evicted };
  }

  async oldest(limit: number): Promise<StoredRequest[]> {
    const tx = this.db.transaction([META, BODY], "readonly");
    const out: StoredRequest[] = [];
    const req = tx.objectStore(META).getAll(null, limit);
    req.onsuccess = () => {
      for (const m of req.result as Meta[]) {
        const b = tx.objectStore(BODY).get(m.id);
        b.onsuccess = () => {
          const { bytes: _bytes, ...rest } = m;
          if (b.result) out.push({ ...rest, body: b.result as Uint8Array });
        };
      }
    };
    await done(tx);
    return out.sort((a, b) => a.id! - b.id!);
  }

  async update(entry: StoredRequest): Promise<void> {
    if (entry.id === undefined) return;
    const tx = this.db.transaction([META], "readwrite");
    const metas = tx.objectStore(META);
    const get = metas.get(entry.id);
    get.onsuccess = () => {
      if (get.result) metas.put({ ...(get.result as Meta), attempts: entry.attempts, notBefore: entry.notBefore });
    };
    await done(tx);
  }

  async delete(id: number): Promise<void> {
    const tx = this.db.transaction([META, BODY], "readwrite");
    tx.objectStore(META).delete(id);
    tx.objectStore(BODY).delete(id);
    await done(tx);
  }
}

function indexedDBFactory(): IDBFactory | undefined {
  try {
    // Reading the property throws a SecurityError where storage is blocked (sandboxed iframes, some privacy settings).
    return typeof indexedDB === "undefined" ? undefined : indexedDB;
  } catch {
    return undefined;
  }
}

export interface StoreOptions {
  maxBytes: number;
  logger: DebugLogger;
  /** Defaults to the global `indexedDB`; null forces memory. */
  factory?: IDBFactory | null;
  name?: string;
}

/**
 * IndexedDB with a memory fallback: the database opens in the background (calls wait for it), and
 * the store switches to memory for good when it cannot open or an operation fails for any reason
 * but a full disk. A full disk (`QuotaExceededError`) keeps that one entry in memory instead.
 */
export class ResilientStore implements OfflineStore {
  private idb: Promise<IdbStore | null>;
  private failed = false;
  private readonly memory: MemoryStore;
  private readonly logger: DebugLogger;

  constructor(opts: StoreOptions) {
    this.memory = new MemoryStore(opts.maxBytes);
    this.logger = opts.logger;
    const factory = opts.factory === undefined ? indexedDBFactory() : opts.factory;
    if (!factory) {
      this.failed = true;
      this.idb = Promise.resolve(null);
      return;
    }
    this.idb = openDatabase(factory, opts.name).then(
      (db) => new IdbStore(db, opts.maxBytes),
      (err) => {
        this.fail("open", err);
        return null;
      },
    );
  }

  get kind(): "indexeddb" | "memory" {
    return this.failed ? "memory" : "indexeddb";
  }

  /** Resolves once the store knows whether IndexedDB works. */
  ready(): Promise<void> {
    return this.idb.then(() => undefined);
  }

  async put(entry: StoredRequest): Promise<PutResult> {
    const idb = await this.idb;
    if (idb && !this.failed) {
      try {
        return await idb.put(entry);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "QuotaExceededError") {
          this.logger.warn("delivery: storage full, keeping the request in memory");
        } else {
          this.fail("put", err);
        }
      }
    }
    const res = await this.memory.put(entry);
    return { ...res, id: res.id === null ? null : -res.id };
  }

  async oldest(limit: number): Promise<StoredRequest[]> {
    // Memory entries first: they exist only in this page.
    const mem = await this.memory.oldest(limit);
    if (mem.length > 0) return mem.map((e) => ({ ...e, id: -e.id! }));
    const idb = await this.idb;
    if (!idb || this.failed) return [];
    try {
      return await idb.oldest(limit);
    } catch (err) {
      this.fail("read", err);
      return [];
    }
  }

  // Memory entries carry negative ids outside this class so they never collide with IndexedDB keys.
  async update(entry: StoredRequest): Promise<void> {
    if (entry.id !== undefined && entry.id < 0) return this.memory.update({ ...entry, id: -entry.id });
    await this.withIdb("update", (s) => s.update(entry));
  }

  async delete(id: number): Promise<void> {
    if (id < 0) return this.memory.delete(-id);
    await this.withIdb("delete", (s) => s.delete(id));
  }

  private async withIdb(op: string, fn: (s: IdbStore) => Promise<void>): Promise<void> {
    const idb = await this.idb;
    if (!idb || this.failed) return;
    try {
      await fn(idb);
    } catch (err) {
      this.fail(op, err);
    }
  }

  private fail(op: string, err: unknown): void {
    if (!this.failed) this.logger.warn(`delivery: IndexedDB unavailable (${op}), keeping unsent requests in memory`, err);
    this.failed = true;
  }
}
