import { INVALID_SPAN_CONTEXT, ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span, type SpanContext, type SpanKind, type Tracer } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { serializeError } from "./errors/classify";
import { guard } from "./guard";
import { safeString } from "./text";
import { sdkContext as context } from "./telemetry/context";
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

/** What `startSpan` returns when the SDK cannot make a span: valid to call, records nothing. */
export const noopSpan = (): Span => trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/**
 * Public span API (checklist G3) on the SDK's tracer: every span gets the session attributes.
 * `onError` receives an error that escaped `withSpan`, after the span was linked to it: it is
 * reported as an `exception` log record with the span's ids (spec SIG-33), never as a span
 * event (REL-7).
 */
export function createSpanApi(tracer: Tracer, linker: TraceLinker, onError?: (error: unknown) => void): SpanApi {
  const start = (name: string, options: SpanOptions = {}): Span =>
    tracer.startSpan(
      safeString(name),
      {
        ...(options.attributes ? { attributes: options.attributes } : {}),
        ...(options.kind !== undefined ? { kind: options.kind as SpanKind } : {}),
        ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
      },
      parentContext(options.parent),
    );
  // The SDK's part of `withSpan` runs inside the guard; the app's function does not.
  const end = (span: Span, failed?: { error: unknown }): void => {
    guard.run("withSpan.end", () => {
      if (failed) {
        const s = serializeError(failed.error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: s.message });
        linker.rememberError(failed.error, span);
        onError?.(failed.error);
      }
      span.end();
    });
  };
  return {
    startSpan: (name, options) => guard.run("startSpan", () => start(name, options ?? {})) ?? noopSpan(),
    withSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T {
      if (typeof fn !== "function") return undefined as T;
      const span = guard.run("withSpan.start", () => start(name, options ?? {})) ?? noopSpan();
      let result: T;
      try {
        result = context.with(trace.setSpan(context.active(), span), () => fn(span));
      } catch (err) {
        end(span, { error: err });
        throw err;
      }
      if (result && typeof (result as { then?: unknown }).then === "function") {
        return (result as unknown as Promise<unknown>).then(
          (v) => {
            end(span);
            return v;
          },
          (err: unknown) => {
            end(span, { error: err });
            throw err;
          },
        ) as unknown as T;
      }
      end(span);
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
 * `Sentry.logger.*` entries (spec section 7a), so both read alike in Loki.
 * The record carries the session attributes and the active span's trace id and span id.
 */
export function createLogApi(events: EventEmitter, clean: (attrs: unknown) => Attrs = (a) => (a && typeof a === "object" ? (a as Attrs) : {})): RUMLog {
  const emit = (level: LogLevel, message: string, attrs?: Attrs, options?: { span?: Span }): void => {
    guard.run("log", () => {
      const sev = (typeof level === "string" ? LEVELS[level] : undefined) ?? LEVELS.info;
      const body = safeString(message);
      events.emitRecord({
        eventName: "log",
        body,
        timestamp: Date.now(),
        severityNumber: sev.number,
        severityText: sev.text,
        attributes: { ...clean(attrs), "event.name": "log", message: body.length > MAX_MESSAGE ? body.slice(0, MAX_MESSAGE) : body },
        context: options?.span && typeof options.span.spanContext === "function" ? trace.setSpan(context.active(), options.span) : context.active(),
      });
    });
  };
  const log = ((level: LogLevel, message: string, attrs?: Attrs, options?: { span?: Span }) => emit(level, message, attrs, options)) as RUMLog;
  for (const level of Object.keys(LEVELS) as LogLevel[]) {
    log[level] = (message: string, attrs?: Attrs, options?: { span?: Span }) => emit(level, message, attrs, options);
  }
  return log;
}
