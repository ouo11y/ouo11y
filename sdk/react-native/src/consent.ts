import type { AsyncKeyValueStorage } from "./types";

/**
 * Consent (spec PRV-1 to PRV-4), the storage half: while telemetry consent is pending or denied
 * nothing is written to persistent storage. The few small records the SDK keeps (session, user,
 * crash marker, error context, replay tallies) land in a memory overlay instead, so their
 * writers work unchanged; reads see the overlay first, then what earlier runs left. The offline
 * store does not use the overlay: it keeps its requests in memory itself while held
 * (`Outbox.hold`), so the overlay stays as small as the number of those keys.
 *
 * - `allow()`: consent granted. The overlay is written out and writes go straight through.
 * - `hold()`: consent withdrawn. The overlay is discarded and writes are held in memory again.
 * - `purge(keys)`: deletes those keys from the persistent storage itself (withdrawal), after
 *   every write still on its way there has landed, so none can land after the delete.
 *
 * Transitions must not overlap: the caller runs them one after the other (`init`'s consent queue).
 */
export class ConsentStorage implements AsyncKeyValueStorage {
  /** `null` marks a key removed while held. */
  private overlay = new Map<string, string | null>();
  /** Writes handed to the persistent storage that have not settled yet. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly inner: AsyncKeyValueStorage,
    private persist: boolean,
  ) {}

  getItem(key: string): Promise<string | null> {
    if (this.overlay.has(key)) return Promise.resolve(this.overlay.get(key) ?? null);
    return this.inner.getItem(key);
  }

  setItem(key: string, value: string): Promise<void> {
    if (this.persist) return this.write(() => this.inner.setItem(key, value));
    this.overlay.set(key, value);
    return Promise.resolve();
  }

  removeItem(key: string): Promise<void> {
    if (this.persist) return this.write(() => this.inner.removeItem(key));
    this.overlay.set(key, null);
    return Promise.resolve();
  }

  /** Whether writes reach the persistent storage. */
  get persistent(): boolean {
    return this.persist;
  }

  /** Entries held in memory (tests). */
  get held(): number {
    return this.overlay.size;
  }

  async allow(): Promise<void> {
    if (this.persist) return;
    this.persist = true;
    const held = this.overlay;
    this.overlay = new Map();
    for (const [key, value] of held) {
      // One failed write must not keep the others from landing.
      await this.write(() => (value === null ? this.inner.removeItem(key) : this.inner.setItem(key, value))).catch(() => undefined);
    }
  }

  hold(): void {
    this.persist = false;
    this.overlay = new Map();
  }

  async purge(keys: string[]): Promise<void> {
    await Promise.all(Array.from(this.inFlight));
    for (const key of keys) {
      this.overlay.delete(key);
      await this.write(() => this.inner.removeItem(key)).catch(() => undefined);
    }
  }

  /** A call into the persistent storage, tracked until it settles; a synchronous throw is a rejection. */
  private write(call: () => Promise<void>): Promise<void> {
    const p = Promise.resolve().then(call);
    const tracked = p.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(tracked);
    void tracked.then(() => this.inFlight.delete(tracked));
    return p;
  }
}
