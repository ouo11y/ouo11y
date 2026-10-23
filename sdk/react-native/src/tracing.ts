import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span, type SpanContext, type SpanKind, type Tracer } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { serializeError } from "./errors/classify";
import type { EventEmitter } from "./telemetry/events";
import type { Attrs, LogLevel, RUMLog, SpanOptions } from "./types";

/** A failed request this recent is taken as the cause of an error that has no span of its own. */
export const RECENT_FAILED_REQUEST_MS = 2000;

export type TraceLink = "span" | "active_span" | "failed_request";

/**
 * Which trace an error belongs to (checklist G5, "trace id on errors"), most precise first:
 * 1. the span the error escaped from (`withSpan`, a fetch / XHR that rejected with it);
 * 2. the span active when it was reported (`captureError` or `console.error` inside `withSpan`);
 * 3. a request that failed less than 2 s before (a response handler that threw on a 500).
 * The exception record then carries that trace id and span id, and `ouo.exception.trace_link`
 * says which rule matched.
 */
export class TraceLinker {
  private readonly errorSpans = new WeakMap<object, SpanContext>();
  private lastFailed: { span: SpanContext; at: number } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  rememberError(error: unknown, span: Span): void {
    if (error && typeof error === "object" && !this.errorSpans.has(error)) this.errorSpans.set(error, span.spanContext());
  }

  noteFailedRequest(span: Span): void {
    this.lastFailed = { span: span.spanContext(), at: this.now() };
  }

  contextFor(error: unknown): { context: Context; link: TraceLink } | undefined {
    const own = error && typeof error === "object" ? this.errorSpans.get(error) : undefined;
    if (own) return { context: trace.setSpanContext(ROOT_CONTEXT, own), link: "span" };
    const active = trace.getSpan(context.active());
    if (active && active.spanContext().traceId) return { context: context.active(), link: "active_span" };
    const f = this.lastFailed;
    if (f && this.now() - f.at <= RECENT_FAILED_REQUEST_MS) return { context: trace.setSpanContext(ROOT_CONTEXT, f.span), link: "failed_request" };
    return undefined;
  }
}

function parentContext(parent: SpanOptions["parent"]): Context {
  if (parent === null) return ROOT_CONTEXT;
  if (!parent) return context.active();
  const sc = typeof (parent as Span).spanContext === "function" ? (parent as Span).spanContext() : (parent as SpanContext);
  return trace.setSpanContext(ROOT_CONTEXT, sc);
}

export interface SpanApi {
  startSpan(name: string, options?: SpanOptions): Span;
  withSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T;
}

/** Public span API (checklist G3) on the SDK's tracer: every span gets the session attributes. */
export function createSpanApi(tracer: Tracer, linker: TraceLinker): SpanApi {
  const start = (name: string, options: SpanOptions = {}): Span =>
    tracer.startSpan(
      name,
      {
        ...(options.attributes ? { attributes: options.attributes } : {}),
        ...(options.kind !== undefined ? { kind: options.kind as SpanKind } : {}),
        ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
      },
      parentContext(options.parent),
    );
  const fail = (span: Span, err: unknown): void => {
    const s = serializeError(err);
    span.recordException({ name: s.type, message: s.message, ...(s.stacktrace ? { stack: s.stacktrace } : {}) });
    span.setStatus({ code: SpanStatusCode.ERROR, message: s.message });
    linker.rememberError(err, span);
  };
  return {
    startSpan: start,
    withSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T {
      const span = start(name, options);
      let result: T;
      try {
        result = context.with(trace.setSpan(context.active(), span), () => fn(span));
      } catch (err) {
        fail(span, err);
        span.end();
        throw err;
      }
      if (result && typeof (result as { then?: unknown }).then === "function") {
        return (result as unknown as Promise<unknown>).then(
          (v) => {
            span.end();
            return v;
          },
          (err: unknown) => {
            fail(span, err);
            span.end();
            throw err;
          },
        ) as unknown as T;
      }
      span.end();
      return result;
    },
  };
}

const LEVELS: Record<LogLevel, { number: SeverityNumber; text: string }> = {
  trace: { number: SeverityNumber.TRACE, text: "TRACE" },
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
  fatal: { number: SeverityNumber.FATAL, text: "FATAL" },
};

/** Longest `message` attribute, as the Sentry bridge truncates log bodies (spec section 7a). */
const MAX_MESSAGE = 1024;

/**
 * Public log API (checklist G3): OTel log records named `log`, as the Sentry bridge emits
 * `Sentry.logger.*` entries (spec section 7a), so both read alike in rum-api's logs view.
 * The record carries the session attributes and the active span's trace id and span id.
 */
export function createLogApi(events: EventEmitter): RUMLog {
  const emit = (level: LogLevel, message: string, attrs?: Attrs, options?: { span?: Span }): void => {
    const sev = LEVELS[level];
    const body = String(message);
    events.emitRecord({
      eventName: "log",
      body,
      timestamp: Date.now(),
      severityNumber: sev.number,
      severityText: sev.text,
      attributes: { ...(attrs ?? {}), "event.name": "log", message: body.length > MAX_MESSAGE ? body.slice(0, MAX_MESSAGE) : body },
      context: options?.span ? trace.setSpan(context.active(), options.span) : context.active(),
    });
  };
  const log = ((level: LogLevel, message: string, attrs?: Attrs, options?: { span?: Span }) => emit(level, message, attrs, options)) as RUMLog;
  for (const level of Object.keys(LEVELS) as LogLevel[]) {
    log[level] = (message: string, attrs?: Attrs, options?: { span?: Span }) => emit(level, message, attrs, options);
  }
  return log;
}
