import type { Context, Span } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { SessionManager } from "../session/manager";
import { signalAttributes } from "../attributes";
import type { Attrs, AttrValue } from "../types";

/**
 * Shared by both processors: the route template set with `rum.setRoute` (`app.screen.name`) and the
 * app's attribute set (`rum.setAttributes`; the user's set is the session manager's).
 */
export class RouteState {
  name: string | undefined;
  attrs: Attrs = {};
}

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
    private readonly route: RouteState = new RouteState(),
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    span.setAttributes(correlationAttributes(this.session, this.serviceVersion));
    span.setAttributes(signalAttributes(this.session.userAttributes(), this.route.attrs));
    if (this.route.name) span.setAttribute("app.screen.name", this.route.name);
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
 * A `session.start` / `session.end` record names its own session: it must neither inherit
 * the active session's ids nor, by asking for the active id, create a session (a
 * `session.end` is emitted at the moment there is no active session, so `session.id()`
 * would start one; see project/agents/qa/reports/phase-6-bugs.html bug 1).
 */
export class SessionLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly session: SessionManager,
    private readonly serviceVersion: string,
    private readonly route: RouteState = new RouteState(),
  ) {}

  onEmit(record: SdkLogRecord): void {
    const existing = record.attributes;
    const set = (key: string, value: AttrValue): void => {
      if (existing[key] === undefined) record.setAttribute(key, value);
    };
    // A `navigation` record is written before the app renders the new route, so the route
    // known at that moment is the previous page's: leave it off.
    if (this.route.name && existing["event.name"] !== "navigation") set("app.screen.name", this.route.name);
    // The user set is read now: a user_change session.end is emitted before the user is swapped.
    const custom = signalAttributes(this.session.userAttributes(), this.route.attrs);
    for (const key in custom) set(key, custom[key]!);
    if (existing["session.id"] !== undefined) {
      // Record about a named session: fill the non-session fields only, without ensure().
      set("user.id", this.session.userId());
      set("ouo.user.anonymous", this.session.isAnonymousUser());
      set("ouo.platform", "web");
      set("service.version", this.serviceVersion);
      const current = this.session.peek();
      if (current && current.id === existing["session.id"] && current.previousId) set("session.previous_id", current.previousId);
      return;
    }
    const attrs = correlationAttributes(this.session, this.serviceVersion);
    for (const key of Object.keys(attrs)) set(key, attrs[key]!);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
