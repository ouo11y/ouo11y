import { trace, ROOT_CONTEXT, type Attributes, type Context, type Span, type Tracer } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { systemClock, type Clock } from "../session/clock";

export type IdleSpanKind = "click" | "navigation";
export type IdleEndReason = "idle" | "timeout" | "superseded" | "hidden";

/** An interaction or soft-navigation span that stays open until the page settles. */
export interface IdleSpan {
  readonly kind: IdleSpanKind;
  readonly span: Span;
  readonly context: Context;
  readonly spanId: string;
  readonly startedAt: number;
  /** Epoch ms of the last child start or end, or DOM mutation; the span ends here. */
  lastActivity: number;
  /** Child spans still open (fetch, XHR, a soft navigation under a click). */
  inflight: number;
  /** Child spans started under this span. */
  children: number;
  /** A DOM mutation was observed while this span was the innermost open one. */
  mutated: boolean;
  /** Never a parent and never exported: only used to watch for activity (dead clicks without click spans). */
  readonly detached: boolean;
  /** Called once when the span ends, with the reason. */
  onEnd: ((s: IdleSpan, reason: IdleEndReason) => void) | undefined;
  timer: unknown;
  deadline: unknown;
}

export interface InteractionTrackerOptions {
  tracer: () => Tracer;
  /** The span ends this long after the last activity. Default 1000 ms. */
  idleTimeoutMs?: number;
  /** Hard cap on a span's duration. Default 15000 ms. */
  maxDurationMs?: number;
  clock?: Clock;
  /** MutationObserver constructor; injectable for tests. Default the global one. */
  mutationObserver?: typeof MutationObserver | undefined;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 1000;
export const DEFAULT_MAX_DURATION_MS = 15000;

/**
 * Opens "idle spans" for clicks and soft navigations (the pattern RUM SDKs use without async
 * context): while one is open its context is the fallback parent for spans started from the
 * root context, so the fetch a click handler issues after an `await` is the click's child. A
 * span ends `idleTimeoutMs` after the last activity (child span start or end, DOM mutation),
 * at the time of that activity, or at `maxDurationMs`.
 *
 * Also a SpanProcessor: it counts the open children of each idle span. Click spans that got
 * no child are dropped from export (`shouldExport`): a click that only changed the DOM is a
 * timeline event, not a trace.
 */
export class InteractionTracker implements SpanProcessor {
  private readonly open: IdleSpan[] = [];
  private readonly byId = new Map<string, IdleSpan>();
  /** Child span id -> parent idle span, to account for the child when it ends. */
  private readonly childOf = new Map<string, IdleSpan>();
  private readonly dropped = new Set<string>();
  private readonly idleTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly clock: Clock;
  private readonly MO: typeof MutationObserver | undefined;
  private observer: MutationObserver | undefined;

  constructor(private readonly opts: InteractionTrackerOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.clock = opts.clock ?? systemClock;
    this.MO = "mutationObserver" in opts ? opts.mutationObserver : globalThis.MutationObserver;
  }

  /** Opens an idle span. A new click ends an open click; a new navigation ends an open navigation. */
  begin(
    kind: IdleSpanKind,
    name: string,
    attributes: Attributes,
    options: { parent?: Context; startTime?: number; detached?: boolean; onEnd?: (s: IdleSpan, reason: IdleEndReason) => void } = {},
  ): IdleSpan {
    for (const o of [...this.open].reverse()) {
      if (o.kind === kind) this.finish(o, "superseded");
    }
    const now = this.clock.now();
    const startedAt = options.startTime ?? now;
    const parent = options.parent ?? ROOT_CONTEXT;
    const span = this.opts.tracer().startSpan(name, { attributes, startTime: startedAt }, parent);
    const s: IdleSpan = {
      kind,
      span,
      context: trace.setSpan(parent, span),
      spanId: span.spanContext().spanId,
      startedAt,
      lastActivity: Math.max(startedAt, now),
      inflight: 0,
      children: 0,
      mutated: false,
      detached: options.detached === true,
      onEnd: options.onEnd,
      timer: null,
      deadline: null,
    };
    s.deadline = this.clock.setTimeout(() => this.finish(s, "timeout"), Math.max(0, startedAt + this.maxDurationMs - now));
    this.open.push(s);
    this.byId.set(s.spanId, s);
    this.observe();
    this.schedule(s);
    return s;
  }

  /** Context of the innermost open idle span, the fallback parent (FallbackContextManager). */
  activeContext(): Context | undefined {
    for (let i = this.open.length - 1; i >= 0; i--) if (!this.open[i]!.detached) return this.open[i]!.context;
    return undefined;
  }

  /** The innermost open idle span of a kind. */
  current(kind: IdleSpanKind): IdleSpan | undefined {
    for (let i = this.open.length - 1; i >= 0; i--) if (this.open[i]!.kind === kind) return this.open[i];
    return undefined;
  }

  /** A DOM mutation counts as activity for the innermost open span. */
  noteMutation(): void {
    const s = this.open[this.open.length - 1];
    if (!s) return;
    s.mutated = true;
    s.lastActivity = this.clock.now();
    this.schedule(s);
  }

  /** Ends every open span (page hidden or unloading). */
  endAll(reason: IdleEndReason = "hidden"): void {
    for (const s of [...this.open].reverse()) this.finish(s, reason);
  }

  shouldExport(span: ReadableSpan): boolean {
    const id = span.spanContext().spanId;
    if (!this.dropped.has(id)) return true;
    this.dropped.delete(id);
    return false;
  }

  // ---- SpanProcessor ----

  onStart(span: Span, parentContext: Context): void {
    const parentId = trace.getSpanContext(parentContext)?.spanId;
    const s = parentId ? this.byId.get(parentId) : undefined;
    if (!s) return;
    s.inflight += 1;
    s.children += 1;
    s.lastActivity = this.clock.now();
    this.childOf.set(span.spanContext().spanId, s);
    this.schedule(s);
  }

  onEnd(span: ReadableSpan): void {
    const id = span.spanContext().spanId;
    const s = this.childOf.get(id);
    if (!s) return;
    this.childOf.delete(id);
    s.inflight = Math.max(0, s.inflight - 1);
    s.lastActivity = Math.max(s.lastActivity, hrToMs(span.endTime));
    if (this.byId.has(s.spanId)) this.schedule(s);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.endAll("hidden");
    return Promise.resolve();
  }

  // ---- internals ----

  private schedule(s: IdleSpan): void {
    if (s.timer !== null) this.clock.clearTimeout(s.timer);
    s.timer = null;
    if (s.inflight > 0) return;
    const delay = Math.max(0, s.lastActivity + this.idleTimeoutMs - this.clock.now());
    s.timer = this.clock.setTimeout(() => {
      s.timer = null;
      if (s.inflight === 0 && this.clock.now() - s.lastActivity >= this.idleTimeoutMs) this.finish(s, "idle");
      else this.schedule(s);
    }, delay);
  }

  private finish(s: IdleSpan, reason: IdleEndReason): void {
    if (!this.byId.has(s.spanId)) return;
    this.byId.delete(s.spanId);
    this.open.splice(this.open.indexOf(s), 1);
    if (s.timer !== null) this.clock.clearTimeout(s.timer);
    if (s.deadline !== null) this.clock.clearTimeout(s.deadline);
    s.timer = s.deadline = null;
    if (this.open.length === 0) this.disconnect();
    s.span.setAttribute("ouo.interaction.end_reason", reason);
    if (s.detached || (s.kind === "click" && s.children === 0)) this.dropped.add(s.spanId);
    const end = reason === "timeout" ? s.startedAt + this.maxDurationMs : Math.max(s.startedAt, s.lastActivity);
    s.span.end(end);
    s.onEnd?.(s, reason);
  }

  private observe(): void {
    if (this.observer || !this.MO || typeof document === "undefined") return;
    this.observer = new this.MO(() => this.noteMutation());
    this.observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  private disconnect(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}

/** Wraps a processor and drops the spans `keep` rejects from its `onEnd`. */
export class FilteringSpanProcessor implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly keep: (span: ReadableSpan) => boolean,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span as never, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (this.keep(span)) this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function hrToMs(t: readonly [number, number]): number {
  return t[0] * 1000 + t[1] / 1e6;
}
