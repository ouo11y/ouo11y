import type { Context, Span } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SessionManager } from "../session/manager";
import type { Attrs, AttrValue } from "../types";

/** The app's `ouo.attr.*` and `ouo.app.bundle.*` attributes of the moment (docs/specs/attributes.md). */
export type CustomAttributes = () => Attrs;
const none: CustomAttributes = () => ({});

export const PLATFORM = "mobile";

/** Attributes every span and log record must carry (spec: identifiers carried on every signal). */
export function correlationAttributes(session: SessionManager, serviceVersion: string): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {
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
    private readonly custom: CustomAttributes = none,
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    span.setAttributes(correlationAttributes(this.session, this.serviceVersion));
    span.setAttributes(this.custom());
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
    private readonly custom: CustomAttributes = none,
  ) {}

  onEmit(record: SdkLogRecord): void {
    const existing = record.attributes;
    const set = (key: string, value: AttrValue): void => {
      if (existing[key] === undefined) record.setAttribute(key, value);
    };
    set("ouo.platform", PLATFORM);
    set("service.version", this.serviceVersion);
    const stampCustom = (): void => {
      const custom = this.custom();
      for (const key of Object.keys(custom)) set(key, custom[key]!);
    };
    if (existing["session.id"] !== undefined) {
      // Record about a named session (session.start / session.end): fill only user fields.
      set("user.id", this.session.userId());
      set("ouo.user.anonymous", this.session.isAnonymousUser());
      const current = this.session.peek();
      if (current && current.id === existing["session.id"]) {
        if (current.previousId) set("session.previous_id", current.previousId);
        // Only the live session's: a previous run's crash or session.end must not take this run's
        // attributes or OTA bundle.
        stampCustom();
      }
      return;
    }
    const attrs = correlationAttributes(this.session, this.serviceVersion);
    for (const key of Object.keys(attrs)) set(key, attrs[key]!);
    stampCustom();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
