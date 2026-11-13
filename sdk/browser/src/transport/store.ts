/**
 * The outbox: request bodies that must outlive the page (SDK spec sections 8.3 and 8.4). Replay
 * chunks are written here before their first send (RPL-15); telemetry is written at page hide.
 * IndexedDB when it works (shared by the origin's tabs, so a later page sends what this one could
 * not), memory otherwise (TRN-15). Bounded by a byte cap: eviction is oldest first, replay before
 * telemetry before bypass records (TRN-14), and entries past their time to live are removed
 * (TRN-13). No method rejects: a storage failure costs the entry, never the page.
 *
 * Bodies are stored as they are sent; request headers (the project credential) are not stored.
 */
import { guard, point } from "../guard";

export type OutboxKind = "replay" | "telemetry" | "bypass";

export interface OutboxEntry {
  id?: number;
  kind: OutboxKind;
  /** `logs`, `traces` or `replay`: picks the URL and content type at send time. */
  signal: "logs" | "traces" | "replay";
  body: Uint8Array;
  /** Records in the body, for drop accounting. */
  records: number;
  createdAt: number;
  /** Replay only: the stream and sequence (`-1`: the stream's end record). */
  stream?: string;
  seq?: number;
}

export type OutboxMeta = Omit<OutboxEntry, "body"> & { id: number; bytes: number };

/** A replay stream this origin has opened and not finished delivering (RPL-20, TRN-18). */
export interface StreamRow {
  stream: string;
  replay: string;
  session: string;
  /** Highest sequence produced, -1 when none. */
  last: number;
  /** `ouo.replay.ended` was produced for it. */
  ended: boolean;
  partial: boolean;
  mode: string;
  updatedAt: number;
}

export interface PutResult {
  id: number | null;
  evicted: OutboxMeta[];
}

export interface Outbox {
  readonly kind: "indexeddb" | "memory";
  put(entry: OutboxEntry): Promise<PutResult>;
  /** Metadata of every entry, oldest first. Entries older than `ttlMs` are removed and returned in `expired`. */
  list(now: number, ttlMs: number): Promise<{ entries: OutboxMeta[]; expired: OutboxMeta[] }>;
  body(id: number): Promise<Uint8Array | undefined>;
  delete(id: number): Promise<void>;
  /** Removes everything, or only one kind (consent withdrawal). */
  clear(kind?: OutboxKind): Promise<void>;
  putStream(row: StreamRow): Promise<void>;
  streams(): Promise<StreamRow[]>;
  deleteStream(stream: string): Promise<void>;
}

const RANK: Record<OutboxKind, number> = { replay: 0, telemetry: 1, bypass: 2 };

/** What to evict so the total fits the cap: replay, then telemetry, then bypass, oldest first; never `keep`. */
export function toEvict(metas: OutboxMeta[], cap: number, keep: number): OutboxMeta[] {
  let total = metas.reduce((n, m) => n + m.bytes, 0);
  const out: OutboxMeta[] = [];
  for (const m of [...metas].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.id - b.id)) {
    if (total <= cap) break;
    if (m.id === keep) continue;
    out.push(m);
    total -= m.bytes;
  }
  return out;
}

export class MemoryOutbox implements Outbox {
  readonly kind = "memory" as const;
  private readonly entries = new Map<number, OutboxEntry & { id: number }>();
  private readonly rows = new Map<string, StreamRow>();
  private nextId = 1;

  constructor(private readonly maxBytes: number) {}

  private metas(): OutboxMeta[] {
    return [...this.entries.values()].map(({ body, ...rest }) => ({ ...rest, bytes: body.byteLength }));
  }

  async put(entry: OutboxEntry): Promise<PutResult> {
    if (entry.body.byteLength > this.maxBytes) return { id: null, evicted: [] };
    const id = this.nextId++;
    this.entries.set(id, { ...entry, id });
    const evicted = toEvict(this.metas(), this.maxBytes, id);
    for (const m of evicted) this.entries.delete(m.id);
    return { id, evicted };
  }

  async list(now: number, ttlMs: number): Promise<{ entries: OutboxMeta[]; expired: OutboxMeta[] }> {
    const expired = this.metas().filter((m) => now - m.createdAt > ttlMs);
    for (const m of expired) this.entries.delete(m.id);
    return { entries: this.metas().sort((a, b) => a.id - b.id), expired };
  }

  async body(id: number): Promise<Uint8Array | undefined> {
    return this.entries.get(id)?.body;
  }

  async delete(id: number): Promise<void> {
    this.entries.delete(id);
  }

  async clear(kind?: OutboxKind): Promise<void> {
    for (const [id, e] of this.entries) if (!kind || e.kind === kind) this.entries.delete(id);
    if (!kind || kind === "replay") this.rows.clear();
  }

  async putStream(row: StreamRow): Promise<void> {
    this.rows.set(row.stream, { ...row });
  }
  async streams(): Promise<StreamRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async deleteStream(stream: string): Promise<void> {
    this.rows.delete(stream);
  }
}

/** Version 1 of the outbox database. The MVP's `ouo-delivery` database is removed when seen. */
export const IDB_NAME = "ouo-outbox";
const LEGACY_IDB_NAME = "ouo-delivery";
const META = "meta";
const BODY = "body";
const STREAMS = "streams";

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** Opens the database; rejects on error, on a blocked upgrade, or after `timeoutMs` (Safari can hang). */
export function openDatabase(factory: IDBFactory, name = IDB_NAME, timeoutMs = 3000): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("indexedDB open timed out")), timeoutMs);
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    let req: IDBOpenDBRequest;
    try {
      point("store.open");
      req = factory.open(name, 1);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BODY)) db.createObjectStore(BODY);
      if (!db.objectStoreNames.contains(STREAMS)) db.createObjectStore(STREAMS, { keyPath: "stream" });
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

/** Metadata and bodies in two object stores, so the cap is enforced without reading bodies. */
export class IdbOutbox implements Outbox {
  readonly kind = "indexeddb" as const;

  constructor(
    private readonly db: IDBDatabase,
    private readonly maxBytes: number,
  ) {}

  async put(entry: OutboxEntry): Promise<PutResult> {
    point("store.put");
    const bytes = entry.body.byteLength;
    if (bytes > this.maxBytes) return { id: null, evicted: [] };
    const { body, id: _ignored, ...rest } = entry;
    // The key is made here, not by the database, so both writes are issued in this very task
    // and committed at once: a write that waits for a callback is lost when the page is closing.
    const id = Date.now() * 4096 + Math.floor(Math.random() * 4096);
    const tx = this.db.transaction([META, BODY], "readwrite");
    tx.objectStore(META).put({ ...rest, id, bytes });
    tx.objectStore(BODY).put(body, id);
    try {
      (tx as IDBTransaction & { commit?: () => void }).commit?.();
    } catch {
      // Commits by itself.
    }
    await done(tx);
    // The cap is enforced in a second transaction; tabs writing at once may overshoot it briefly.
    const evicted: OutboxMeta[] = [];
    const trim = this.db.transaction([META, BODY], "readwrite");
    const metas = trim.objectStore(META);
    const all = metas.getAll();
    all.onsuccess = guard(() => {
      for (const m of toEvict(all.result as OutboxMeta[], this.maxBytes, id)) {
        metas.delete(m.id);
        trim.objectStore(BODY).delete(m.id);
        evicted.push(m);
      }
    });
    await done(trim);
    return { id, evicted };
  }

  async list(now: number, ttlMs: number): Promise<{ entries: OutboxMeta[]; expired: OutboxMeta[] }> {
    const tx = this.db.transaction([META, BODY], "readwrite");
    const metas = tx.objectStore(META);
    const entries: OutboxMeta[] = [];
    const expired: OutboxMeta[] = [];
    const all = metas.getAll();
    all.onsuccess = guard(() => {
      for (const m of all.result as OutboxMeta[]) {
        if (now - m.createdAt > ttlMs) {
          metas.delete(m.id);
          tx.objectStore(BODY).delete(m.id);
          expired.push(m);
        } else entries.push(m);
      }
    });
    await done(tx);
    return { entries: entries.sort((a, b) => a.id - b.id), expired };
  }

  async body(id: number): Promise<Uint8Array | undefined> {
    const tx = this.db.transaction([BODY], "readonly");
    const req = tx.objectStore(BODY).get(id);
    await done(tx);
    const v = req.result as unknown;
    // A body that is not bytes is corrupt data: treated as missing.
    return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : undefined;
  }

  async delete(id: number): Promise<void> {
    const tx = this.db.transaction([META, BODY], "readwrite");
    tx.objectStore(META).delete(id);
    tx.objectStore(BODY).delete(id);
    await done(tx);
  }

  async clear(kind?: OutboxKind): Promise<void> {
    const tx = this.db.transaction([META, BODY, STREAMS], "readwrite");
    const metas = tx.objectStore(META);
    if (!kind) {
      metas.clear();
      tx.objectStore(BODY).clear();
      tx.objectStore(STREAMS).clear();
    } else {
      const all = metas.getAll();
      all.onsuccess = guard(() => {
        for (const m of all.result as OutboxMeta[]) {
          if (m.kind !== kind) continue;
          metas.delete(m.id);
          tx.objectStore(BODY).delete(m.id);
        }
      });
      if (kind === "replay") tx.objectStore(STREAMS).clear();
    }
    await done(tx);
  }

  async putStream(row: StreamRow): Promise<void> {
    const tx = this.db.transaction([STREAMS], "readwrite");
    tx.objectStore(STREAMS).put(row);
    try {
      (tx as IDBTransaction & { commit?: () => void }).commit?.();
    } catch {
      // Commits by itself.
    }
    await done(tx);
  }

  async streams(): Promise<StreamRow[]> {
    const tx = this.db.transaction([STREAMS], "readonly");
    const req = tx.objectStore(STREAMS).getAll();
    await done(tx);
    return (req.result as StreamRow[]).filter((r) => r && typeof r.stream === "string");
  }

  async deleteStream(stream: string): Promise<void> {
    const tx = this.db.transaction([STREAMS], "readwrite");
    tx.objectStore(STREAMS).delete(stream);
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

export interface OutboxOptions {
  maxBytes: number;
  /** Called once when IndexedDB fails and the outbox degrades to memory (counted, TRN-15). */
  onDegrade?: (op: string) => void;
  /** Defaults to the global `indexedDB`; null forces memory. */
  factory?: IDBFactory | null;
  name?: string;
}

/**
 * IndexedDB with a memory fallback: the database opens in the background (calls wait for it), and
 * the outbox switches to memory for good when it cannot open or an operation fails. Memory entries
 * carry negative ids so they never collide with IndexedDB keys.
 */
export class ResilientOutbox implements Outbox {
  private readonly idb: Promise<IdbOutbox | null>;
  private failed = false;
  private readonly memory: MemoryOutbox;

  constructor(private readonly opts: OutboxOptions) {
    this.memory = new MemoryOutbox(opts.maxBytes);
    const factory = opts.factory === undefined ? indexedDBFactory() : opts.factory;
    if (!factory) {
      this.failed = true;
      this.idb = Promise.resolve(null);
      return;
    }
    this.idb = openDatabase(factory, opts.name).then(
      (db) => {
        try {
          factory.deleteDatabase(LEGACY_IDB_NAME);
        } catch {
          // Best effort.
        }
        return new IdbOutbox(db, opts.maxBytes);
      },
      () => {
        this.fail("open");
        return null;
      },
    );
  }

  get kind(): "indexeddb" | "memory" {
    return this.failed ? "memory" : "indexeddb";
  }

  private async use<T>(op: string, fn: (s: IdbOutbox) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    const idb = await this.idb;
    if (idb && !this.failed) {
      try {
        return await fn(idb);
      } catch {
        this.fail(op);
      }
    }
    return fallback();
  }

  private fail(op: string): void {
    if (this.failed) return;
    this.failed = true;
    try {
      this.opts.onDegrade?.(op);
    } catch {
      // The listener's problem.
    }
  }

  put(entry: OutboxEntry): Promise<PutResult> {
    return this.use(
      "put",
      (s) => s.put(entry),
      async () => {
        const res = await this.memory.put(entry);
        return { id: res.id === null ? null : -res.id, evicted: res.evicted.map((m) => ({ ...m, id: -m.id })) };
      },
    );
  }

  async list(now: number, ttlMs: number): Promise<{ entries: OutboxMeta[]; expired: OutboxMeta[] }> {
    const neg = (m: OutboxMeta): OutboxMeta => ({ ...m, id: -m.id });
    const mem = await this.memory.list(now, ttlMs);
    const disk = await this.use("list", (s) => s.list(now, ttlMs), async () => ({ entries: [], expired: [] }));
    return { entries: [...disk.entries, ...mem.entries.map(neg)], expired: [...disk.expired, ...mem.expired.map(neg)] };
  }

  body(id: number): Promise<Uint8Array | undefined> {
    if (id < 0) return this.memory.body(-id);
    return this.use("body", (s) => s.body(id), async () => undefined);
  }

  delete(id: number): Promise<void> {
    if (id < 0) return this.memory.delete(-id);
    return this.use("delete", (s) => s.delete(id), async () => undefined);
  }

  async clear(kind?: OutboxKind): Promise<void> {
    await this.memory.clear(kind);
    await this.use("clear", (s) => s.clear(kind), async () => undefined);
  }

  putStream(row: StreamRow): Promise<void> {
    return this.use("putStream", (s) => s.putStream(row), () => this.memory.putStream(row));
  }

  async streams(): Promise<StreamRow[]> {
    const mem = await this.memory.streams();
    const disk = await this.use("streams", (s) => s.streams(), async () => [] as StreamRow[]);
    return [...disk, ...mem];
  }

  async deleteStream(stream: string): Promise<void> {
    await this.memory.deleteStream(stream);
    await this.use("deleteStream", (s) => s.deleteStream(stream), async () => undefined);
  }
}
