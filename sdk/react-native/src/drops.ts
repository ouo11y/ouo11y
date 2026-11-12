/**
 * Drop counting (spec ERR-7): every record the SDK drops is counted by signal and reason, and
 * the counts are reported as `ouo.sdk.dropped` events, at most once per flush interval.
 *
 * Drop events are never counted as drops and never cause more drop events: callers skip them
 * with `isDropEvent`, so a drop event that is itself dropped (sampling, a full queue) is silent.
 * The table is bounded: one counter per signal and reason.
 */

import { guard } from "./guard";

export const DROP_EVENT = "ouo.sdk.dropped";
/** How often counts are reported, at most: the log batcher's flush interval. */
export const DROP_REPORT_INTERVAL_MS = 1000;

export type DropSignal = "log" | "span" | "attribute";

export type DropReason =
  /** The batch queue in memory was full. */
  | "queue_full"
  /** The offline store was over its bounds: the oldest request was evicted. */
  | "outbox_evicted"
  /** The collector answered with a non-retryable status (spec 8.2). */
  | "rejected_status"
  /** The collector accepted the request but rejected some of its records (`partial_success`). */
  | "partial_rejected"
  /** One record alone is over `transport.maxRequestBytes`. */
  | "too_large"
  /** No valid session, and the record is not in the bypass set (spec SES-10). */
  | "no_session"
  /** The session is outside the session sample. */
  | "sampling"
  /** `beforeSend` returned null or false. */
  | "before_send"
  /** An app-supplied name in a reserved prefix (`session.`, `ouo.`). */
  | "reserved_name"
  /** A public function was called with an input it cannot record (no name, not a string). */
  | "invalid"
  /** The offline store could not be used: the records are in memory only (they are sent, but a kill loses them). */
  | "persistence_failed"
  /** The SDK disabled itself after too many internal errors. */
  | "self_disabled";

export interface DropCount {
  signal: DropSignal;
  reason: DropReason;
  count: number;
}

export type DropListener = (drops: DropCount[]) => void;

/** True for the SDK's own drop event: never counted, so reporting cannot feed itself. */
export function isDropEvent(name: unknown): boolean {
  return name === DROP_EVENT;
}

export class DropCounter {
  private readonly pending = new Map<string, DropCount>();
  private readonly totals = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private report: DropListener | undefined;
  private stopped = false;

  /** Where the counts go (`ouo.sdk.dropped` events). Without a listener they are only totalled. */
  onReport(listener: DropListener): void {
    this.report = listener;
  }

  count(signal: DropSignal, reason: DropReason, n = 1): void {
    if (!(n > 0)) return;
    const key = `${signal}|${reason}`;
    this.totals.set(key, (this.totals.get(key) ?? 0) + n);
    const p = this.pending.get(key);
    if (p) p.count += n;
    else this.pending.set(key, { signal, reason, count: n });
    if (this.timer === undefined && !this.stopped && this.report) {
      this.timer = setTimeout(
        guard.wrap("timer.drops", () => {
          this.timer = undefined;
          this.flush();
        }),
        DROP_REPORT_INTERVAL_MS,
      );
    }
  }

  /** Total dropped so far for a signal and reason (tests, debug). */
  total(signal: DropSignal, reason: DropReason): number {
    return this.totals.get(`${signal}|${reason}`) ?? 0;
  }

  /** Reports what was counted since the last report. */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0 || !this.report || this.stopped) return;
    const drops = Array.from(this.pending.values());
    this.pending.clear();
    this.report(drops);
  }

  /** No more reports; counting goes on (totals). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
