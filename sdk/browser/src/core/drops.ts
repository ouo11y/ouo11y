/**
 * Drop accounting (ERR-7): every record the SDK drops is counted by signal and reason, and the
 * counts leave as `ouo.sdk.dropped` events, at most once per flush interval. A drop event is
 * never counted as a drop itself and never causes another one.
 */
export type DropReason =
  | "no_session"
  | "queue_full"
  | "rate_limited"
  | "before_send"
  | "reserved_name"
  | "invalid_attribute"
  | "rejected_status"
  | "partial_rejected"
  | "expired"
  | "storage_full"
  | "storage_error"
  | "bypass_cap"
  | "consent"
  | "too_large"
  | "internal_error"
  | "backlog"
  | "mask_failed";

export interface DropReport {
  signal: string;
  reason: DropReason;
  count: number;
}

export class DropCounter {
  private counts = new Map<string, number>();
  /** Totals since init, for `stats()` and tests. */
  readonly totals = new Map<string, number>();
  private listener: (() => void) | undefined;

  /** Called once whenever a count goes from nothing to something (to arm the report timer). */
  onFirst(listener: (() => void) | undefined): void {
    this.listener = listener;
  }

  add(signal: string, reason: DropReason, count = 1): void {
    if (count <= 0 || signal === "ouo.sdk.dropped") return;
    const key = `${signal}\n${reason}`;
    const first = this.counts.size === 0;
    this.counts.set(key, (this.counts.get(key) ?? 0) + count);
    this.totals.set(key, (this.totals.get(key) ?? 0) + count);
    // Bounded (ERR-9): signals are event names, which an app can invent without limit.
    if (this.counts.size > 64) this.counts.delete(this.counts.keys().next().value!);
    if (this.totals.size > 256) this.totals.delete(this.totals.keys().next().value!);
    if (first) this.listener?.();
  }

  /** The counts since the last call, emptied. */
  take(): DropReport[] {
    const out: DropReport[] = [];
    for (const [key, count] of this.counts) {
      const [signal, reason] = key.split("\n") as [string, DropReason];
      out.push({ signal, reason, count });
    }
    this.counts = new Map();
    return out;
  }

  /** Puts reports back (they could not be sent yet: no session). */
  restore(reports: DropReport[]): void {
    for (const r of reports) {
      const key = `${r.signal}\n${r.reason}`;
      this.counts.set(key, (this.counts.get(key) ?? 0) + r.count);
    }
  }

  total(signal?: string, reason?: DropReason): number {
    let n = 0;
    for (const [key, count] of this.totals) {
      const [s, r] = key.split("\n");
      if ((signal === undefined || s === signal) && (reason === undefined || r === reason)) n += count;
    }
    return n;
  }
}
