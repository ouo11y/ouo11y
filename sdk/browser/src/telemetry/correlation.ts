import type { Context, Span } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { SessionManager } from "../session/manager";
import type { AttrValue } from "../types";

/** Attributes every span and log record must carry (spec: identifiers carried on every signal). */
export function correlationAttributes(session: SessionManager, serviceVersion: string): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {
    "session.id": session.id(),
    "user.id": session.userId(),
    "ouo.user.anonymous": session.isAnonymousUser(),
    "ouo.platform": "web",
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
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    span.setAttributes(correlationAttributes(this.session, this.serviceVersion));
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Adds session identifiers to every log record unless the record already carries them (session.end does). */
export class SessionLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly session: SessionManager,
    private readonly serviceVersion: string,
  ) {}

  onEmit(record: SdkLogRecord): void {
    const existing = record.attributes;
    const attrs = correlationAttributes(this.session, this.serviceVersion);
    // A session.end record names the session that just ended; it must not inherit the
    // new session's previous_id (which is itself).
    const ownSession = existing["session.id"] === undefined || existing["session.id"] === attrs["session.id"];
    for (const key of Object.keys(attrs)) {
      if (!ownSession && key === "session.previous_id") continue;
      if (existing[key] === undefined) record.setAttribute(key, attrs[key]!);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
