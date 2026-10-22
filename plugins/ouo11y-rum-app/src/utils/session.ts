import type { LogLine, SessionDetail, TimelineEvent, TraceSummary } from '../api/types';
import { parseTs } from './format';

/**
 * The session's timeline with nothing before the session start (C4): an event recorded before
 * `session.start` (the Sentry bridge's first screen comes from a transaction that starts a few
 * seconds before the SDK's session init) is moved to the start, keeping its recorded time in
 * `clampedFrom`, and `session.start` comes first. Otherwise the order is kept.
 */
export function clampToSessionStart(timeline: readonly TimelineEvent[], sessionStart: number): TimelineEvent[] {
  if (!Number.isFinite(sessionStart)) {
    return [...timeline];
  }
  const startIso = new Date(sessionStart).toISOString();
  const early: TimelineEvent[] = [];
  const rest: TimelineEvent[] = [];
  let start: TimelineEvent | undefined;
  for (const ev of timeline) {
    const ts = parseTs(ev.ts);
    if (ev.type === 'session.start' && !start) {
      start = ev;
    } else if (Number.isFinite(ts) && ts < sessionStart) {
      early.push({ ...ev, ts: startIso, clampedFrom: ev.ts });
    } else {
      rest.push(ev);
    }
  }
  if (!start && early.length === 0) {
    return [...timeline];
  }
  return [...(start ? [start] : []), ...early, ...rest];
}

export interface ContextField {
  label: string;
  value: string;
}

/**
 * Device, OS, build and environment for the session header (C2), from the detail's `context`
 * (rum-api after 0.3.0) and, for older rum-api versions, the attributes the timeline still carries.
 * Fields with no value are left out.
 */
export function sessionContextFields(
  session: Pick<SessionDetail, 'context' | 'timeline' | 'service_version'>
): ContextField[] {
  const ctx: Record<string, string> = {};
  for (const ev of session.timeline ?? []) {
    for (const [k, v] of Object.entries(ev.attrs ?? {})) {
      if (v) {
        ctx[k] = v;
      }
    }
  }
  Object.assign(ctx, session.context ?? {});
  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' ');
  const model = ctx.device_model_name || ctx.device_model_identifier;
  const device =
    model &&
    ctx.device_model_name &&
    ctx.device_model_identifier &&
    ctx.device_model_name !== ctx.device_model_identifier
      ? `${join(ctx.device_manufacturer, ctx.device_model_name)} (${ctx.device_model_identifier})`
      : join(ctx.device_manufacturer, model);
  const build = ctx.ouo_app_build ? join(session.service_version, `(build ${ctx.ouo_app_build})`) : '';
  const fields: ContextField[] = [
    { label: 'Device', value: device },
    { label: 'OS', value: join(ctx.os_name, ctx.os_version) },
    { label: 'Build', value: build },
    { label: 'Environment', value: ctx.deployment_environment_name ?? '' },
  ];
  return fields.filter((f) => f.value);
}

/** `HTTP GET`, `GET`: the HTTP semconv fallback name, with no route in it. */
const GENERIC_HTTP = /^(?:HTTP )?([A-Z]+)$/;

/**
 * Name of a trace in the traces table (C6): the root span name, except that a generic `HTTP GET`
 * root becomes `GET /path`, the `{method} {url.path}` form the Sentry bridge gives its http spans.
 */
export function traceDisplayName(t: Pick<TraceSummary, 'root_name' | 'root_url_path'>): string {
  const m = GENERIC_HTTP.exec(t.root_name ?? '');
  if (m && t.root_url_path) {
    return `${m[1]} ${t.root_url_path}`;
  }
  return t.root_name || '(no root span)';
}

/** `Type: message` of an exception record, or '' when it has neither. */
export function exceptionSummary(attrs: Record<string, string> | undefined): string {
  const type = attrs?.exception_type ?? '';
  const message = attrs?.exception_message ?? '';
  return `${type}${type && message ? ': ' : ''}${message}`;
}

/** True for a log line that is an exception record (ouo SDK `exception` event or OTel exception attrs). */
export const isExceptionLine = (l: Pick<LogLine, 'event_name' | 'attrs'>) =>
  l.event_name === 'exception' || Boolean(l.attrs?.exception_type || l.attrs?.exception_message);

/**
 * Text of a log line (C7): exception records show `Type: message`, because their body is empty
 * (the ouo SDKs) or the bare message (the Sentry bridge).
 */
export function logLineText(l: Pick<LogLine, 'body' | 'event_name' | 'attrs'>): string {
  if (isExceptionLine(l)) {
    return exceptionSummary(l.attrs) || l.body;
  }
  return l.body;
}
