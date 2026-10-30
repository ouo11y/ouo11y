import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";

/** How many events `ouo.last_events` carries (docs/specs/mobile-sdk.md C10). */
export const LAST_EVENTS = 20;
/** Longest `body` of one entry. */
export const LAST_EVENT_BODY_MAX = 200;

/** One entry of `ouo.last_events`: when, which record, and the step as a person reads it. */
export interface RecentEvent {
  /** Epoch ms. */
  ts: number;
  /** `event.name` of the record (`ui.tap`, `navigation`, `log`, `exception`, ...). */
  name: string;
  /** The step: path, error, request from the attributes, else the record's body when it is more than its name; may be "". */
  body: string;
}

/**
 * Keeps the last LAST_EVENTS records of the session's timeline, as they are emitted: every event
 * and log line of the SDK, in order. Runs after `SessionLogProcessor`, so each record carries its
 * `session.id`, and before sampling. `read(sessionId)` returns that session's entries, oldest
 * first: what a `feedback` (and, with W4, an `exception`) carries as `ouo.last_events`.
 */
export class RecentEvents implements LogRecordProcessor {
  private entries: Array<RecentEvent & { session: string }> = [];

  onEmit(record: SdkLogRecord): void {
    const a = record.attributes;
    const session = a["session.id"];
    if (typeof session !== "string") return;
    const name = String(a["event.name"] ?? record.eventName ?? "log");
    const [s, ns] = record.hrTime;
    this.entries.push({ ts: s * 1000 + Math.floor(ns / 1e6), name, body: cut(summary(name, record.body, a)), session });
    if (this.entries.length > LAST_EVENTS) this.entries.shift();
  }

  /** The last events of `sessionId`, oldest first. */
  read(sessionId: string): RecentEvent[] {
    return this.entries.filter((e) => e.session === sessionId).map(({ ts, name, body }) => ({ ts, name, body }));
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** `ouo.last_events`: the entries as one JSON array string (one attribute, as Loki keeps it). */
export function lastEventsAttribute(events: readonly RecentEvent[]): string {
  return JSON.stringify(events);
}

/** The records whose step is in their attributes; every other record reads as its body. */
function summary(name: string, body: unknown, a: Record<string, unknown>): string {
  const s = (k: string): string => (a[k] === undefined ? "" : String(a[k]));
  switch (name) {
    case "navigation":
      return s("url.path");
    case "exception":
      return [s("exception.type"), s("exception.message")].filter(Boolean).join(": ");
    case "http.request":
    case "http.request.failed":
      return [s("http.request.method"), s("url.full"), s("http.response.status_code")].filter(Boolean).join(" ");
    default:
      return typeof body === "string" && body !== name ? body : "";
  }
}

function cut(s: string): string {
  if (s.length <= LAST_EVENT_BODY_MAX) return s;
  const code = s.charCodeAt(LAST_EVENT_BODY_MAX - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? LAST_EVENT_BODY_MAX - 1 : LAST_EVENT_BODY_MAX);
}
