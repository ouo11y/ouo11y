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

/** localStorage wrapper that never throws (private mode, quota, disabled storage). */
export class LocalStorage implements KeyValueStorage {
  private readonly fallback = new MemoryStorage();
  get(key: string): string | null {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return this.fallback.get(key);
    }
  }
  set(key: string, value: string): void {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      this.fallback.set(key, value);
    }
  }
  remove(key: string): void {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      this.fallback.remove(key);
    }
  }
}
