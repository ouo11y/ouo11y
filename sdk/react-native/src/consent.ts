import type { AsyncKeyValueStorage } from "./types";

/**
 * Consent (spec PRV-1 to PRV-4), the storage half: while telemetry consent is pending or denied
 * nothing is written to persistent storage. Writes land in a memory overlay instead (bounded by
 * what the SDK writes: the session record and the offline store, which has its own bounds), so
 * the rest of the SDK works unchanged; reads see the overlay first, then what earlier runs left.
 *
 * - `allow()`: consent granted. The overlay is written out and writes go straight through.
 * - `hold()`: consent withdrawn. The overlay is discarded and writes are held in memory again.
 * - `purge(keys)`: deletes those keys from the persistent storage itself (withdrawal).
 */
export class ConsentStorage implements AsyncKeyValueStorage {
  /** `null` marks a key removed while held. */
  private overlay = new Map<string, string | null>();

  constructor(
    private readonly inner: AsyncKeyValueStorage,
    private persist: boolean,
  ) {}

  getItem(key: string): Promise<string | null> {
    if (this.overlay.has(key)) return Promise.resolve(this.overlay.get(key) ?? null);
    return this.inner.getItem(key);
  }

  setItem(key: string, value: string): Promise<void> {
    if (this.persist) return this.inner.setItem(key, value);
    this.overlay.set(key, value);
    return Promise.resolve();
  }

  removeItem(key: string): Promise<void> {
    if (this.persist) return this.inner.removeItem(key);
    this.overlay.set(key, null);
    return Promise.resolve();
  }

  /** Whether writes reach the persistent storage. */
  get persistent(): boolean {
    return this.persist;
  }

  async allow(): Promise<void> {
    if (this.persist) return;
    this.persist = true;
    const held = this.overlay;
    this.overlay = new Map();
    for (const [key, value] of held) {
      // One failed write must not keep the others from landing.
      await (value === null ? this.inner.removeItem(key) : this.inner.setItem(key, value)).catch(() => undefined);
    }
  }

  hold(): void {
    this.persist = false;
    this.overlay = new Map();
  }

  async purge(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.overlay.delete(key);
      await Promise.resolve()
        .then(() => this.inner.removeItem(key))
        .catch(() => undefined);
    }
  }
}
