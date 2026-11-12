import type { Context, Span } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { isBypassRecord } from "../sampling";
import type { SessionManager } from "../session/manager";
import type { AttrValue } from "../types";

export const PLATFORM = "mobile";

/** `user.id`, only once the app called `setUser` (spec PRV-13): the SDK makes up no id. */
function userAttributes(session: SessionManager): Record<string, AttrValue> {
  const id = session.userId();
  return id ? { "user.id": id, "ouo.user.anonymous": false } : {};
}

/**
 * Attributes every span and log record carries (spec: identifiers carried on every signal), or
 * undefined when no session is valid: telemetry never starts a session (spec SES-10).
 */
export function correlationAttributes(session: SessionManager, serviceVersion: string, globals?: () => Record<string, AttrValue>): Record<string, AttrValue> | undefined {
  const current = session.active();
  if (!current) return undefined;
  const attrs: Record<string, AttrValue> = {
    // `setGlobalAttributes`: under the SDK's own attributes, which win on a clash.
    ...globals?.(),
    "session.id": current.id,
    "ouo.platform": PLATFORM,
    "service.version": serviceVersion,
    ...userAttributes(session),
  };
  if (current.previousId) attrs["session.previous_id"] = current.previousId;
  return attrs;
}

/** Adds session identifiers to every span when it starts. A span started while no session is valid gets none and is dropped when it ends. */
export class SessionSpanProcessor implements SpanProcessor {
  constructor(
    private readonly session: SessionManager,
    private readonly serviceVersion: string,
    private readonly globals?: () => Record<string, AttrValue>,
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    const attrs = correlationAttributes(this.session, this.serviceVersion, this.globals);
    if (attrs) span.setAttributes(attrs);
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Adds session identifiers to every log record unless the record already carries them.
 * A `session.end` record names the session that just ended: it must neither inherit the
 * replacement session's ids nor, by asking for the active id, create that replacement
 * while the app sits in the background.
 *
 * While no session is valid (spec SES-10) a bypass-set record (an unhandled exception, a hang)
 * goes out with the last session's id and `ouo.session.expired = true`; any other record gets no
 * `session.id`, and the gate drops and counts it (`no_session`).
 */
export class SessionLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly session: SessionManager,
    private readonly serviceVersion: string,
    private readonly globals?: () => Record<string, AttrValue>,
  ) {}

  onEmit(record: SdkLogRecord): void {
    const existing = record.attributes;
    const set = (key: string, value: AttrValue): void => {
      if (existing[key] === undefined) record.setAttribute(key, value);
    };
    if (existing["session.id"] !== undefined) {
      // Record about a named session (session.start / session.end, a crash): fill only user fields.
      const current = this.session.peek();
      if (current && current.id === existing["session.id"] && current.previousId) set("session.previous_id", current.previousId);
    } else {
      const attrs = correlationAttributes(this.session, this.serviceVersion);
      if (attrs) {
        for (const key of Object.keys(attrs)) set(key, attrs[key]!);
      } else if (isBypassRecord(existing)) {
        set("session.id", this.session.lastId());
        set("ouo.session.expired", true);
      } else {
        return;
      }
    }
    set("ouo.platform", PLATFORM);
    set("service.version", this.serviceVersion);
    const user = userAttributes(this.session);
    for (const key of Object.keys(user)) set(key, user[key]!);
    // `setGlobalAttributes`, last: what the record or the SDK already set wins.
    const globals = this.globals?.();
    if (globals) for (const key of Object.keys(globals)) set(key, globals[key]!);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
