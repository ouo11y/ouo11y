import type { AsyncKeyValueStorage } from "../types";

/** In-memory AsyncStorage stand-in for tests and for the web target. */
export class MemoryAsyncStorage implements AsyncKeyValueStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  removeItem(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  /** Test helper: synchronous read. */
  peek(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  /** Test helper: snapshot of all keys, to hand to a "next launch". */
  clone(): MemoryAsyncStorage {
    const s = new MemoryAsyncStorage();
    for (const [k, v] of this.map) s.map.set(k, v);
    return s;
  }
}

/** Wraps any AsyncStorage-like object so a throwing or rejecting implementation never breaks the SDK. */
export function safeStorage(inner: AsyncKeyValueStorage, onError?: (err: unknown) => void): AsyncKeyValueStorage {
  const guard = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      onError?.(err);
      return fallback;
    }
  };
  return {
    getItem: (key) => guard(() => inner.getItem(key), null),
    setItem: (key, value) => guard(() => inner.setItem(key, value), undefined),
    removeItem: (key) => guard(() => inner.removeItem(key), undefined),
  };
}

/** Rejects after `ms` so a hung storage read cannot delay `session.start` forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(fallback);
        }
      },
    );
  });
}
