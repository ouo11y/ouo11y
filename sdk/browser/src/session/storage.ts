/** Minimal synchronous key/value store, injectable for tests. */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

/** Keys the SDK writes; copied to memory when the platform storage stops working. */
const PREFIX = "ouo.";

/**
 * Web Storage wrapper that never throws. The `localStorage` getter throws in sandboxed and
 * some third-party iframes (SecurityError), `setItem` throws when the quota is full (Safari
 * private mode before 11 had a quota of 0) and either can be replaced by a page. On the first
 * failure the store switches to memory for the rest of the page view, after copying the `ouo.*`
 * keys it can still read: mixing the two would read a stale record from storage after a write
 * that only reached memory. The session then lives as long as the page, which is the best a
 * page without storage can do.
 */
export class LocalStorage implements KeyValueStorage {
  private memory: MemoryStorage | null = null;

  constructor(private readonly area: () => Storage | null | undefined = () => globalThis.localStorage) {
    // Probe once so a store that cannot write is detected before the session is read from it.
    const probe = `${PREFIX}probe`;
    this.use((s) => {
      s.setItem(probe, "1");
      s.removeItem(probe);
    });
  }

  /** True once the store fell back to memory. */
  inMemory(): boolean {
    return this.memory !== null;
  }

  get(key: string): string | null {
    let value: string | null = null;
    if (!this.memory && this.use((s) => (value = s.getItem(key)))) return value;
    return this.memory!.get(key);
  }
  set(key: string, value: string): void {
    if (!this.memory && this.use((s) => s.setItem(key, value))) return;
    this.memory!.set(key, value);
  }
  remove(key: string): void {
    if (!this.memory && this.use((s) => s.removeItem(key))) return;
    this.memory!.remove(key);
  }

  /** Runs `fn` on the platform store; on any failure switches to memory and returns false. */
  private use(fn: (s: Storage) => unknown): boolean {
    try {
      const s = this.area();
      if (!s) throw new Error("no storage");
      fn(s);
      return true;
    } catch {
      this.fallBack();
      return false;
    }
  }

  private fallBack(): void {
    if (this.memory) return;
    const memory = new MemoryStorage();
    try {
      const s = this.area();
      for (let i = 0; s && i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(PREFIX)) memory.set(k, s.getItem(k) ?? "");
      }
    } catch {
      // Unreadable too: start empty.
    }
    this.memory = memory;
  }
}

/**
 * Storage that honours consent (PRV-1, PRV-4): memory while consent is pending or denied,
 * `localStorage` once granted. `persist()` moves what memory holds into `localStorage`;
 * `forget()` removes the SDK's keys from it and goes back to memory.
 */
export class ConsentStorage implements KeyValueStorage {
  private memory = new MemoryStorage();
  private disk: LocalStorage | null = null;
  private readonly keys = new Set<string>();

  constructor(persistent: boolean, private readonly area?: () => Storage | null | undefined) {
    if (persistent) this.disk = new LocalStorage(this.area);
  }

  persistent(): boolean {
    return this.disk !== null && !this.disk.inMemory();
  }

  persist(): void {
    if (this.disk) return;
    const disk = new LocalStorage(this.area);
    for (const key of this.keys) {
      const v = this.memory.get(key);
      if (v !== null) disk.set(key, v);
    }
    this.disk = disk;
    this.memory = new MemoryStorage();
  }

  forget(): void {
    for (const key of this.keys) this.disk?.remove(key);
    this.disk = null;
    this.memory = new MemoryStorage();
    this.keys.clear();
  }

  get(key: string): string | null {
    return (this.disk ?? this.memory).get(key);
  }
  set(key: string, value: string): void {
    this.keys.add(key);
    (this.disk ?? this.memory).set(key, value);
  }
  remove(key: string): void {
    this.keys.delete(key);
    (this.disk ?? this.memory).remove(key);
  }
}
