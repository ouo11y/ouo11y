import type { Context, Span } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SessionManager } from "../session/manager";
import type { AttrValue } from "../types";

export const PLATFORM = "mobile";

/** Attributes every span and log record must carry (spec: identifiers carried on every signal). */
export function correlationAttributes(session: SessionManager, serviceVersion: string, globals?: () => Record<string, AttrValue>): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {
    // `setGlobalAttributes`: under the SDK's own attributes, which win on a clash.
    ...globals?.(),
    "session.id": session.id(),
    "user.id": session.userId(),
    "ouo.user.anonymous": session.isAnonymousUser(),
    "ouo.platform": PLATFORM,
    "service.version": serviceVersion,
  };
  const previous = session.previousId();
  if (previous) attrs["session.previous_id"] = previous;
  return attrs;
}

/** Adds session identifiers to every span when it starts. */
export class SessionSpanProcessor implements SpanProcessor {
  constructor(
    private readonly session: SessionManager,
    private readonly serviceVersion: string,
    private readonly globals?: () => Record<string, AttrValue>,
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    span.setAttributes(correlationAttributes(this.session, this.serviceVersion, this.globals));
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
    set("ouo.platform", PLATFORM);
    set("service.version", this.serviceVersion);
    if (existing["session.id"] !== undefined) {
      // Record about a named session (session.start / session.end): fill only user fields.
      set("user.id", this.session.userId());
      set("ouo.user.anonymous", this.session.isAnonymousUser());
      const current = this.session.peek();
      if (current && current.id === existing["session.id"] && current.previousId) set("session.previous_id", current.previousId);
    } else {
      const attrs = correlationAttributes(this.session, this.serviceVersion);
      for (const key of Object.keys(attrs)) set(key, attrs[key]!);
    }
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
