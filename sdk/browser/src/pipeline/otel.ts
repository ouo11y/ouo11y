/**
 * The OpenTelemetry side of the SDK: one resource, one logger provider and one tracer provider,
 * with processors that add what RUM needs (session, view, sanitised URLs, sampling, consent) and
 * hand the records to the SDK's own queues. The providers are exposed to the host (REL-5) and are
 * registered as the OpenTelemetry globals only when configured (REL-4).
 */
import {
  context as otelContext,
  propagation,
  trace,
  TraceFlags,
  type Attributes,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs, type AnyValue, type Logger } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { browserDetector } from "@opentelemetry/opentelemetry-browser-detector";
import { detectResources, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor, type ReadableLogRecord, type SdkLogRecord } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, SamplingDecision, type ReadableSpan, type Sampler, type SamplingResult, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import type { Config } from "../config";
import type { DropCounter } from "../core/drops";
import { truncateAttributes, type Attrs } from "../core/limits";
import { attempt, point } from "../guard";
import type { Stamp } from "../session/manager";
import { SCHEMA_URL, SCOPE_REPLAY, SCOPE_RUM, SDK_NAME, SDK_VERSION } from "../version";
import { applyBeforeSend } from "./emitter";

export interface PipelineDeps {
  cfg: Config;
  drops: DropCounter;
  stamp(): Stamp;
  viewId(): string | undefined;
  documentUrl(): string;
  sanitize(url: string): string;
  globalAttributes(): Attrs;
  /** False once the SDK is off, shut down, or telemetry consent is denied. */
  active(): boolean;
  /** Where finished records go. */
  logSink(record: ReadableLogRecord): void;
  spanSink(span: ReadableSpan): void;
  /** The session id that may go to the app's backends as baggage: none before consent or without a session. */
  baggageSessionId(): string | undefined;
  /** A span started: a request is under way (dead clicks read this). */
  onSpanStart?(): void;
}

export interface Pipeline {
  resource: Resource;
  loggerProvider: LoggerProvider;
  tracerProvider: BasicTracerProvider;
  /** Scope `ouo.rum`. */
  logger: Logger;
  tracer: Tracer;
  /**
   * Makes one record on scope `ouo.replay` through the Logs API and returns it, synchronously.
   * The replay engine and the recovery of dead streams both use it, so neither can take the
   * record the other asked for.
   */
  makeReplayRecord(name: string, attributes: Record<string, AnyValue>, time: number, observed: number, body?: Uint8Array): ReadableLogRecord | undefined;
  /** A provider whose every tracer is the `ouo.rum` tracer, for the bundled instrumentations (REC-5). */
  rumTracerProvider: TracerProvider;
  /** Ends every span still open with `ouo.span.abandoned=true` (LIF-7). */
  abandonOpenSpans(): void;
  /** Removes what was registered globally and shuts the providers down. */
  close(): Promise<void>;
}

function osFromUserAgent(ua: string): { name: string; version?: string } | undefined {
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/iPhone OS (\d+[._]\d+(?:[._]\d+)?)/))) return { name: "iOS", version: m[1]!.replace(/_/g, ".") };
  if ((m = ua.match(/iPad; CPU OS (\d+[._]\d+(?:[._]\d+)?)/))) return { name: "iPadOS", version: m[1]!.replace(/_/g, ".") };
  if ((m = ua.match(/Android (\d+(?:\.\d+)*)/))) return { name: "Android", version: m[1]! };
  if ((m = ua.match(/Windows NT (\d+(?:\.\d+)*)/))) return { name: "Windows", version: m[1]! };
  if ((m = ua.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/))) return { name: "macOS", version: m[1]!.replace(/_/g, ".") };
  if (/CrOS/.test(ua)) return { name: "ChromeOS" };
  if (/Linux/.test(ua)) return { name: "Linux" };
  return undefined;
}

/**
 * The resource (SDK spec section 7.1): low-cardinality identity that is fixed for the SDK's
 * lifetime. No device, installation, session, view, URL or user on it (RES-1 to RES-3).
 */
export function buildResource(cfg: Pick<Config, "serviceName" | "serviceVersion" | "environment">): Resource {
  const attrs: Attributes = {
    "service.name": cfg.serviceName,
    "telemetry.sdk.name": SDK_NAME,
    "telemetry.sdk.language": "webjs",
    "telemetry.sdk.version": SDK_VERSION,
  };
  if (cfg.serviceVersion) attrs["service.version"] = cfg.serviceVersion;
  if (cfg.environment) attrs["deployment.environment.name"] = cfg.environment;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os = osFromUserAgent(ua);
  if (os) {
    attrs["os.name"] = os.name;
    if (os.version) attrs["os.version"] = os.version;
  }
  // browser.brands, .platform, .mobile, .language where the browser has them; user_agent.original
  // only when it has no brands (RES-0 says to omit it otherwise).
  const detected = attempt(() => detectResources({ detectors: [browserDetector] }));
  for (const [key, value] of Object.entries(detected?.attributes ?? {})) {
    if (value !== undefined && attrs[key] === undefined) attrs[key] = value;
  }
  if (attrs["browser.brands"] !== undefined) delete attrs["user_agent.original"];
  return resourceFromAttributes(attrs);
}

/** Session sampling for spans (SMP-3, SMP-4): record only in a valid, sampled session. */
class SessionSampler implements Sampler {
  constructor(private readonly d: PipelineDeps) {}

  shouldSample(): SamplingResult {
    if (!this.d.active()) return { decision: SamplingDecision.NOT_RECORD };
    const s = this.d.stamp();
    if (s.expired) {
      this.d.drops.add("span", "no_session");
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return { decision: s.sampled ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
  }

  toString(): string {
    return "OuoSessionSampler";
  }
}

const URL_ATTRIBUTES = ["url.full", "http.url"];

/** Stamps spans when they start, finishes them when they end, and remembers which are open. */
class RumSpanProcessor implements SpanProcessor {
  readonly open = new Set<Span>();

  constructor(private readonly d: PipelineDeps) {}

  onStart(span: Span): void {
    attempt(() => {
      const s = this.d.stamp();
      const attrs: Attributes = { ...this.d.globalAttributes(), "session.id": s.id, "browser.document.url.full": this.d.documentUrl() };
      const view = this.d.viewId();
      if (view) attrs["ouo.view.id"] = view;
      if (s.user !== undefined) attrs["enduser.id"] = s.user;
      span.setAttributes(attrs);
      if (this.open.size < 1024) this.open.add(span);
      this.d.onSpanStart?.();
    });
  }

  onEnd(span: ReadableSpan): void {
    attempt(() => {
      this.open.delete(span as unknown as Span);
      if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0 || !this.d.active()) return;
      point("span.end");
      // The span has ended; its attribute bag is still the object the exporter will read.
      const attrs = span.attributes as Record<string, unknown>;
      for (const key of URL_ATTRIBUTES) if (typeof attrs[key] === "string") attrs[key] = this.d.sanitize(attrs[key]);
      // Span events are not used (REL-7); an instrumentation that adds one loses it here.
      if (span.events.length > 0) (span.events as unknown[]).length = 0;
      truncateAttributes(attrs);
      const hook = this.d.cfg.beforeSend;
      if (hook) {
        const out = applyBeforeSend(hook, { type: "span", name: span.name, attributes: attrs });
        if (!out) {
          this.d.drops.add("span", "before_send");
          return;
        }
        const next = { ...out.attributes, "session.id": attrs["session.id"] };
        for (const k of Object.keys(attrs)) delete attrs[k];
        Object.assign(attrs, next);
        truncateAttributes(attrs);
      }
      this.d.spanSink(span);
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Routes log records: the SDK's own events (already stamped by the emitter) to the telemetry
 * queue, replay records to the replay engine, and the host's records (emitted through the
 * exposed logger provider, REL-5) to the telemetry queue after the same stamping, sampling,
 * truncation and `beforeSend`.
 */
class RouterLogProcessor implements LogRecordProcessor {
  /** Set for the duration of one `makeReplayRecord` call. */
  onReplay: ((record: ReadableLogRecord) => void) | undefined;

  constructor(private readonly d: PipelineDeps) {}

  onEmit(record: SdkLogRecord): void {
    attempt(() => {
      const scope = record.instrumentationScope.name;
      if (scope === SCOPE_REPLAY) {
        this.onReplay?.(record);
        return;
      }
      if (scope === SCOPE_RUM) {
        this.d.logSink(record);
        return;
      }
      if (!this.d.active()) return;
      const name = record.eventName ?? "log";
      const s = this.d.stamp();
      if (s.expired || !s.sampled) {
        if (s.expired) this.d.drops.add(name, "no_session");
        return;
      }
      const attrs: Record<string, unknown> = { ...this.d.globalAttributes(), ...record.attributes, "session.id": s.id, "browser.document.url.full": this.d.documentUrl() };
      const view = this.d.viewId();
      if (view) attrs["ouo.view.id"] = view;
      if (s.user !== undefined) attrs["enduser.id"] = s.user;
      truncateAttributes(attrs);
      let final = attrs;
      const hook = this.d.cfg.beforeSend;
      if (hook) {
        const out = applyBeforeSend(hook, { type: record.eventName ? "event" : "log", name, attributes: attrs, body: record.body });
        if (!out) {
          this.d.drops.add(name, "before_send");
          return;
        }
        final = { ...out.attributes, "session.id": s.id };
        truncateAttributes(final);
        if (out.body !== record.body) record.setBody(out.body as never);
      }
      record.setAttributes(final as never);
      this.d.logSink(record);
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const TRACE_HEADERS = ["traceparent", "tracestate", "baggage"];

/** Trace header values this SDK injected lately, so the XHR shim can tell its own from the app's. */
const injected: string[] = [];

function read(carrier: unknown, name: string): string | undefined {
  if (!carrier || typeof carrier !== "object") return undefined;
  if (typeof Headers !== "undefined" && carrier instanceof Headers) return carrier.get(name) ?? undefined;
  for (const k of Object.keys(carrier)) if (k.toLowerCase() === name) return String((carrier as Record<string, unknown>)[k]);
  return undefined;
}

/** The app set this header itself: it is there, and it is not a value this SDK injected earlier. */
function appSet(carrier: unknown, name: string): boolean {
  const v = read(carrier, name);
  return v !== undefined && !injected.includes(v);
}

/**
 * W3C Trace Context, plus `baggage: session.id=<id>` when configured (PRP-1, PRP-6). Never
 * touches a request on which the app set `traceparent`, and never replaces a `baggage` header the
 * app set (PRP-3). A value this SDK injected into an object the app reuses is the SDK's own and
 * is replaced.
 */
export class RumPropagator implements TextMapPropagator {
  private readonly w3c = new W3CTraceContextPropagator();

  constructor(
    private readonly sessionBaggage: boolean,
    private readonly sessionId: () => string | undefined,
  ) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    if (appSet(carrier, "traceparent")) return;
    const record: TextMapSetter = {
      set: (c, key, value) => {
        if (injected.length >= 32) injected.shift();
        injected.push(value);
        setter.set(c, key, value);
      },
    };
    this.w3c.inject(context, carrier, record);
    if (!this.sessionBaggage || appSet(carrier, "baggage")) return;
    const id = this.sessionId();
    if (id) record.set(carrier, "baggage", `session.id=${id}`);
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.w3c.extract(context, carrier, getter);
  }

  fields(): string[] {
    return this.sessionBaggage ? TRACE_HEADERS : ["traceparent", "tracestate"];
  }
}

/**
 * XHR has no way to read a request header back, so the XHR instrumentation cannot see that the
 * app already set `traceparent` and would add a second value. This wraps `setRequestHeader` to
 * remember which trace headers the app set on each request and to skip the SDK's own value for
 * those (PRP-3). Every other call goes to the original untouched.
 */
export function installXhrHeaderGuard(): () => void {
  const proto = (globalThis as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest?.prototype;
  if (!proto || typeof proto.setRequestHeader !== "function") return () => undefined;
  const original = proto.setRequestHeader;
  const appSet = new WeakMap<XMLHttpRequest, Set<string>>();
  let active = true;
  const patched = function ouoSetRequestHeader(this: XMLHttpRequest, name: string, value: string): void {
    if (active) {
      try {
        const key = String(name).toLowerCase();
        if (TRACE_HEADERS.includes(key)) {
          const ours = injected.includes(String(value));
          const seen = appSet.get(this);
          // The app set its own traceparent: none of the SDK's trace headers are added.
          if (ours && seen?.has("traceparent")) return;
          if (ours && key === "baggage" && seen?.has("baggage")) return;
          if (!ours) {
            if (seen) seen.add(key);
            else appSet.set(this, new Set([key]));
          }
        }
      } catch {
        // Fall through to the original.
      }
    }
    return original.call(this, name, value);
  };
  try {
    proto.setRequestHeader = patched;
  } catch {
    return () => undefined;
  }
  return () => {
    active = false;
    // Restore only what is still ours; a later wrapper keeps working through the inert patch.
    attempt(() => {
      if (proto.setRequestHeader === patched) proto.setRequestHeader = original;
    });
  };
}

export function createPipeline(d: PipelineDeps): Pipeline {
  const resource = buildResource(d.cfg);
  const cleanup: Array<() => unknown> = [];

  const router = new RouterLogProcessor(d);
  const loggerProvider = new LoggerProvider({ resource, processors: [router] });
  const spans = new RumSpanProcessor(d);
  const tracerProvider = new BasicTracerProvider({ resource, sampler: new SessionSampler(d), spanProcessors: [spans] });

  const scope = { schemaUrl: SCHEMA_URL };
  const logger = loggerProvider.getLogger(SCOPE_RUM, SDK_VERSION, scope);
  const replayLogger = loggerProvider.getLogger(SCOPE_REPLAY, SDK_VERSION, scope);
  const tracer = tracerProvider.getTracer(SCOPE_RUM, SDK_VERSION, scope);

  // The fetch and XHR instrumentations make a span active with the context API and inject
  // headers with the propagation API, both of which only exist as globals. They are registered
  // when the host has none of its own; a host that set them first keeps them.
  const contextManager = new StackContextManager();
  contextManager.enable();
  if (otelContext.setGlobalContextManager(contextManager)) cleanup.push(() => otelContext.disable());
  else contextManager.disable();
  const propagator = new RumPropagator(d.cfg.propagation.sessionBaggage, d.baggageSessionId);
  if (propagation.setGlobalPropagator(propagator)) cleanup.push(() => propagation.disable());

  if (d.cfg.otel.registerGlobalProviders) {
    if (trace.setGlobalTracerProvider(tracerProvider)) cleanup.push(() => trace.disable());
    if (logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider) cleanup.push(() => logs.disable());
  }

  return {
    resource,
    loggerProvider,
    tracerProvider,
    logger,
    tracer,
    makeReplayRecord(name, attributes, time, observed, body) {
      let made: ReadableLogRecord | undefined;
      const outer = router.onReplay;
      router.onReplay = (record) => {
        made = record;
      };
      try {
        // A view made here, so the serializer recognises the bytes whatever made the buffer.
        const bytes = body && new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        replayLogger.emit({ eventName: name, timestamp: time, observedTimestamp: observed, attributes, ...(bytes ? { body: bytes as AnyValue } : {}) });
      } finally {
        router.onReplay = outer;
      }
      return made;
    },
    rumTracerProvider: { getTracer: () => tracer },
    abandonOpenSpans() {
      for (const span of [...spans.open]) {
        attempt(() => {
          span.setAttribute("ouo.span.abandoned", true);
          span.end();
        });
      }
      spans.open.clear();
    },
    async close() {
      for (const off of cleanup.reverse()) attempt(off);
      await Promise.all([loggerProvider.shutdown(), tracerProvider.shutdown()]).catch(() => undefined);
    },
  };
}
