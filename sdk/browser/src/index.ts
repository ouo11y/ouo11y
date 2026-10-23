import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

import { installActivityListeners } from "./activity";
import { installClickTracking } from "./interactions/clicks";
import { FallbackContextManager } from "./interactions/context";
import { FilteringSpanProcessor, InteractionTracker } from "./interactions/tracker";
import { installLongTasks } from "./longtasks";
import { exceptionAttributes } from "./errors/classify";
import { claimError, installErrorCapture } from "./errors/install";
import { basicAuthorization, deriveIngestUrls, ingestHeaders } from "./ingest";
import { createLogger } from "./logger";
import { installNavigation } from "./navigation";
import { createNetworkInstrumentations } from "./network";
import { ReplayChunker } from "./replay/chunker";
import { ReplayRecorder } from "./replay/recorder";
import { createChunkUploader } from "./replay/uploader";
import { SESSION_STORAGE_KEY, SessionManager } from "./session/manager";
import { LocalStorage } from "./session/storage";
import { PageLogRecordProcessor, PageSpanProcessor } from "./telemetry/batch";
import { RouteState, SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { SessionPropagator } from "./telemetry/propagator";
import { buildResource } from "./telemetry/resource";
import { SampledLogProcessor, SessionSampler } from "./telemetry/sampling";
import type { Attrs, RUM, RUMOptions, UserOptions } from "./types";
import { installWebVitals } from "./vitals";
import { SDK_NAME, SDK_VERSION } from "./version";

export type * from "./types";
export { SDK_VERSION } from "./version";
export type { ReplayChunk } from "./replay/chunker";
export { basicAuthorization, deriveIngestUrls, deriveReplayEndpoint, type IngestUrls } from "./ingest";

let instance: RUM | undefined;

/** The instance `initRUM` returned, or undefined before it was called (framework integrations use it). */
export function getRUM(): RUM | undefined {
  return instance;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Initialise the ouo browser SDK. Call once, as early as possible. Returns the same
 * instance on repeated calls.
 */
export function initRUM(options: RUMOptions): RUM {
  if (instance) {
    console.warn("[ouo] initRUM called twice; returning the existing instance");
    return instance;
  }
  // Fail fast, before any provider or listener exists: a missing id or token means nothing would be accepted.
  const urls = deriveIngestUrls({
    endpoint: options.endpoint,
    replayEndpoint: options.replayEndpoint,
    projectId: options.projectId,
    projectToken: options.projectToken,
  });
  const authorization = basicAuthorization(options.projectId, options.projectToken);
  const authHeaders = ingestHeaders(authorization);
  const logger = createLogger(options.debug === true);
  if (options.debug) {
    // Never console.error here: the SDK instruments console.error and would report its own diagnostics as exceptions.
    const otelDiag: DiagLogger = {
      error: (...args) => console.warn("[ouo:otel]", ...args),
      warn: (...args) => console.warn("[ouo:otel]", ...args),
      info: (...args) => console.log("[ouo:otel]", ...args),
      debug: (...args) => console.log("[ouo:otel]", ...args),
      verbose: (...args) => console.log("[ouo:otel]", ...args),
    };
    diag.setLogger(otelDiag, DiagLogLevel.INFO);
  }

  const serviceVersion = options.service.version;
  const storage = new LocalStorage();

  // Late-bound: the session manager emits session.start inside start(), after these exist.
  let events: EventEmitter;
  let recorder: ReplayRecorder | undefined;

  const session = new SessionManager({
    storage,
    ...(options.session?.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: options.session.inactivityTimeoutMs } : {}),
    ...(options.session?.maxDurationMs !== undefined ? { maxDurationMs: options.session.maxDurationMs } : {}),
    ...(options.user?.id ? { initialUserId: options.user.id } : {}),
    ...(options.session?.sampleRate !== undefined ? { sessionSampleRate: options.session.sampleRate } : {}),
    logger,
    onEvent: (event) => events.emit(event.name, event.attributes, "info"),
    onRotate: (next, previousId) => recorder?.onRotate(next, previousId),
  });

  const resource = buildResource(options.service);
  const route = new RouteState();

  // ---- logs (events) ----
  const logExporter = new OTLPLogExporter({ url: urls.logs, headers: authHeaders });
  // Not the OTel BatchLogRecordProcessor: it drops a flush requested while one is running,
  // which loses what is emitted at page hide (src/telemetry/batch.ts).
  const logBatch = new PageLogRecordProcessor(logExporter, {
    scheduledDelayMillis: 1000,
    maxExportBatchSize: 64,
    maxQueueSize: 2048,
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SessionLogProcessor(session, serviceVersion, route), new SampledLogProcessor(session, logBatch)],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  events = new EventEmitter(loggerProvider.getLogger(SDK_NAME, SDK_VERSION), logger);

  // ---- traces ----
  const traceExporter = new OTLPTraceExporter({ url: urls.traces, headers: authHeaders });
  // Late-bound: the tracker is a span processor of the provider it gets its tracer from.
  let tracerProvider: WebTracerProvider;
  const tracker = new InteractionTracker({
    tracer: () => tracerProvider.getTracer(SDK_NAME, SDK_VERSION),
    ...(options.tracing?.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.tracing.idleTimeoutMs } : {}),
  });
  tracerProvider = new WebTracerProvider({
    resource,
    sampler: new SessionSampler(session),
    spanProcessors: [
      new SessionSpanProcessor(session, serviceVersion, route),
      tracker,
      new FilteringSpanProcessor(
        new PageSpanProcessor(traceExporter, {
          scheduledDelayMillis: 2000,
          maxExportBatchSize: 64,
          maxQueueSize: 1024,
        }),
        (span) => tracker.shouldExport(span),
      ),
    ],
  });
  const contextManager = new FallbackContextManager();
  tracerProvider.register({ propagator: new SessionPropagator(session), contextManager });
  contextManager.setFallback(() => tracker.activeContext());

  // ---- session ----
  session.start();
  const onActivity = (): void => session.touch();
  const uninstallActivity = installActivityListeners(onActivity);
  const onStorage = (e: StorageEvent): void => {
    if (e.key === SESSION_STORAGE_KEY) session.handleStorageEvent(e.newValue);
  };
  globalThis.addEventListener("storage", onStorage);

  // ---- instrumentation ----
  // The exporters and the uploader already call the un-instrumented fetch; this keeps any
  // other path to the ingest URLs (XHR, a second fetch wrapper) out of the traces too.
  const ignoreUrls: Array<RegExp | string> = [
    new RegExp(`^${escapeRegExp(urls.endpoint)}/v1/`),
    new RegExp(`^${escapeRegExp(urls.replayEndpoint)}/v1/replay/`),
    ...(options.tracing?.ignoreUrls ?? []),
  ];
  const instrumentations: Instrumentation[] = createNetworkInstrumentations({
    events,
    logger,
    propagateTo: options.tracing?.propagateTo ?? [],
    ignoreUrls,
    onActivity,
  });
  if (options.tracing?.documentLoad !== false) {
    instrumentations.push(new DocumentLoadInstrumentation({ ignoreNetworkEvents: true, ignorePerformancePaintEvents: true }));
  }
  registerInstrumentations({ instrumentations, tracerProvider, loggerProvider });

  const uninstallErrors = installErrorCapture({ events, logger });
  const uninstallNavigation = installNavigation({
    events,
    onActivity,
    tracker: options.tracing?.softNavigations === false ? undefined : tracker,
  });
  const uninstallClicks = installClickTracking({
    tracker,
    events,
    spans: options.tracing?.interactions !== false,
    rageClicks: options.clicks?.rageClicks ?? {},
    deadClicks: options.clicks?.deadClicks !== false,
  });
  let uninstallLongTasks = (): void => undefined;
  let uninstallVitals = (): void => undefined;
  if (options.longTasks !== false) {
    try {
      uninstallLongTasks = installLongTasks(events, options.longTasks ?? {});
    } catch (err) {
      logger.warn("long task observer unavailable", err);
    }
  }
  try {
    // A tab opened in the background (and every tab of an automation pane) is hidden from the
    // start: web-vitals then rightly reports no FCP, LCP, CLS or INP for this page view.
    if (document.visibilityState === "hidden") logger.log("page loaded hidden: only TTFB is reported for this page view");
    uninstallVitals = installWebVitals(events);
  } catch (err) {
    logger.warn("web-vitals unavailable", err);
  }

  // ---- replay ----
  const replayEnabled = options.replay?.enabled !== false;
  const chunker = new ReplayChunker({
    sessionId: () => session.id(),
    nextSeq: () => session.nextReplaySeq(),
    upload: createChunkUploader({ replayEndpoint: urls.replayEndpoint, authorization, logger }),
    ...(options.replay?.flushIntervalMs !== undefined ? { flushIntervalMs: options.replay.flushIntervalMs } : {}),
    ...(options.replay?.maxChunkBytes !== undefined ? { maxChunkBytes: options.replay.maxChunkBytes } : {}),
    logger,
  });
  recorder = new ReplayRecorder({
    enabled: replayEnabled,
    maskAllInputs: options.replay?.maskAllInputs !== false,
    sampleRate: options.replay?.sampleRate ?? 1,
    onErrorSampleRate: options.replay?.onErrorSampleRate ?? 0,
    session,
    chunker,
    logger,
  });
  void recorder.start();
  // Error-triggered replay: the first error of a buffering session uploads its replay.
  const unsubscribeErrors = events.subscribe((name, _attrs, severity) => {
    if (name === "exception" && severity === "error") recorder?.onError();
  });

  // ---- lifecycle flushes ----
  const flush = async (): Promise<void> => {
    // Console errors are reported one microtask late (errors/install.ts): let them land first.
    await Promise.resolve();
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), chunker.flush()]);
  };
  // Registered after web-vitals so final vitals emitted on hide are included in the flush.
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      tracker.endAll("hidden");
      void loggerProvider.forceFlush();
      void tracerProvider.forceFlush();
      void chunker.flush();
    }
  };
  const onPageHide = (): void => {
    // Open click and soft-navigation spans end now so the flush below carries them.
    tracker.endAll("hidden");
    void loggerProvider.forceFlush();
    void tracerProvider.forceFlush();
    void chunker.flush({ keepalive: true });
    session.stop();
  };
  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("pagehide", onPageHide);

  // Self-diagnostics: the derived URLs and the project id once, never the token or the header value.
  logger.log(`${SDK_NAME}@${SDK_VERSION} initialised`, {
    endpoint: urls.endpoint,
    replayEndpoint: urls.replayEndpoint,
    traces: urls.traces,
    logs: urls.logs,
    replay: replayEnabled ? urls.replay : null,
    projectId: options.projectId.trim(),
    session: session.id(),
    user: session.userId(),
  });

  const rum: RUM & { _uninstall(): Promise<void> } = {
    setUser(user: UserOptions): void {
      session.setUser(user.id);
      logger.log("user set", user.id);
    },
    captureError(err: unknown, context?: Attrs): void {
      claimError(err);
      events.emit("exception", exceptionAttributes(err, "captured", context), "error");
    },
    addEvent(name: string, attrs?: Attrs): void {
      events.emit(name, { ...(attrs ?? {}), "ouo.event.custom": true });
    },
    setRoute(name: string): void {
      route.name = name || undefined;
      if (name) tracker.current("navigation")?.span.setAttribute("app.screen.name", name);
    },
    replay: {
      pause: () => recorder?.pause(),
      resume: () => recorder?.resume(),
      isRecording: () => recorder?.isRecording() ?? false,
    },
    session: {
      id: () => session.id(),
      userId: () => session.userId(),
    },
    flush,
    async _uninstall(): Promise<void> {
      uninstallActivity();
      uninstallErrors();
      uninstallNavigation();
      uninstallClicks();
      uninstallLongTasks();
      uninstallVitals();
      unsubscribeErrors();
      globalThis.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("pagehide", onPageHide);
      recorder?.shutdown();
      chunker.stop();
      session.stop();
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
      instance = undefined;
    },
  };
  instance = rum;
  return rum;
}
