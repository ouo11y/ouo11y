import { context, diag, DiagLogLevel, propagation, trace, type DiagLogger } from "@opentelemetry/api";
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
import { attempt, guard, quiet, setGuardReporter } from "./guard";
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

let instance: (RUM & { _uninstall(): Promise<void> }) | undefined;

/** The instance `initRUM` returned, or undefined before it was called (framework integrations use it). */
export function getRUM(): RUM | undefined {
  return instance;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What `initRUM` returns where it cannot run (no `window`, server rendering) or failed to start. */
function noopRUM(): RUM & { _uninstall(): Promise<void> } {
  const done = (): Promise<void> => Promise.resolve();
  return {
    setUser: () => undefined,
    captureError: () => undefined,
    addEvent: () => undefined,
    setRoute: () => undefined,
    replay: { pause: () => undefined, resume: () => undefined, isRecording: () => false },
    session: { id: () => "", userId: () => "" },
    flush: done,
    shutdown: done,
    _uninstall: done,
  };
}

/**
 * Initialise the ouo browser SDK. Call once, as early as possible. A second call is a no-op
 * that warns and returns the running instance; after `shutdown()` it starts a new one.
 *
 * Throws only for a configuration error (a missing endpoint, project id or token), so a
 * misconfigured app fails at its first run. Everything else is contained: on the server (no
 * `window`) it returns an inert instance, and if the browser lacks something the SDK needs it
 * warns, removes what it had installed and returns an inert instance.
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
  // Server rendering (Next.js, Remix, Node): nothing to observe, nothing installed.
  if (typeof window === "undefined" || typeof document === "undefined") return noopRUM();

  const cleanup: Array<() => unknown> = [];
  try {
    instance = install(options, urls, authorization, cleanup);
    return instance;
  } catch (err) {
    console.warn("[ouo] the SDK could not start on this page and is disabled", err);
    for (const off of cleanup.reverse()) attempt(off);
    setGuardReporter(undefined);
    instance = undefined;
    return noopRUM();
  }
}

function install(
  options: RUMOptions,
  urls: ReturnType<typeof deriveIngestUrls>,
  authorization: string,
  cleanup: Array<() => unknown>,
): RUM & { _uninstall(): Promise<void> } {
  const authHeaders = ingestHeaders(authorization);
  const logger = createLogger(options.debug === true);
  setGuardReporter((err) => logger.warn("internal error contained", err));
  if (options.debug) {
    // Never console.error here: the SDK instruments console.error and would report its own diagnostics as exceptions.
    const otelDiag: DiagLogger = {
      error: (...args) => console.warn("[ouo:otel]", ...args),
      warn: (...args) => console.warn("[ouo:otel]", ...args),
      info: (...args) => console.log("[ouo:otel]", ...args),
      debug: (...args) => console.log("[ouo:otel]", ...args),
      verbose: (...args) => console.log("[ouo:otel]", ...args),
    };
    if (diag.setLogger(otelDiag, DiagLogLevel.INFO)) cleanup.push(() => diag.disable());
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
  if (logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider) cleanup.push(() => logs.disable());
  cleanup.push(() => loggerProvider.shutdown());
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
  cleanup.push(() => tracerProvider.shutdown());
  // What WebTracerProvider.register does, keeping track of which globals are ours: an app that
  // registered its own OpenTelemetry first keeps it, and shutdown only removes the SDK's.
  const contextManager = new FallbackContextManager();
  contextManager.setFallback(() => tracker.activeContext());
  if (trace.setGlobalTracerProvider(tracerProvider)) cleanup.push(() => trace.disable());
  if (propagation.setGlobalPropagator(new SessionPropagator(session))) cleanup.push(() => propagation.disable());
  contextManager.enable();
  if (context.setGlobalContextManager(contextManager)) cleanup.push(() => context.disable());
  else contextManager.disable();

  // ---- session ----
  session.start();
  cleanup.push(() => session.stop());
  const onActivity = (): void => session.touch();
  cleanup.push(installActivityListeners(onActivity));
  const onStorage = guard((e: StorageEvent): void => {
    if (e.key === SESSION_STORAGE_KEY) session.handleStorageEvent(e.newValue);
  });
  globalThis.addEventListener("storage", onStorage);
  cleanup.push(() => globalThis.removeEventListener("storage", onStorage));

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
  cleanup.push(registerInstrumentations({ instrumentations, tracerProvider, loggerProvider }));

  cleanup.push(installErrorCapture({ events, logger }));
  cleanup.push(
    installNavigation({
    events,
    onActivity,
      tracker: options.tracing?.softNavigations === false ? undefined : tracker,
    }),
  );
  cleanup.push(
    installClickTracking({
      tracker,
      events,
      spans: options.tracing?.interactions !== false,
      rageClicks: options.clicks?.rageClicks ?? {},
      deadClicks: options.clicks?.deadClicks !== false,
    }),
  );
  // Optional platform features: a browser without them gets the rest of the SDK.
  if (options.longTasks !== false) {
    try {
      cleanup.push(installLongTasks(events, options.longTasks ?? {}));
    } catch (err) {
      logger.warn("long task observer unavailable", err);
    }
  }
  try {
    // A tab opened in the background (and every tab of an automation pane) is hidden from the
    // start: web-vitals then rightly reports no FCP, LCP, CLS or INP for this page view.
    if (document.visibilityState === "hidden") logger.log("page loaded hidden: only TTFB is reported for this page view");
    cleanup.push(installWebVitals(events));
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
  cleanup.push(() => chunker.stop());
  recorder = new ReplayRecorder({
    enabled: replayEnabled,
    maskAllInputs: options.replay?.maskAllInputs !== false,
    sampleRate: options.replay?.sampleRate ?? 1,
    onErrorSampleRate: options.replay?.onErrorSampleRate ?? 0,
    blockSelector: options.replay?.blockSelector,
    maskTextSelector: options.replay?.maskTextSelector,
    session,
    chunker,
    logger,
  });
  const rec = recorder;
  cleanup.push(() => rec.shutdown());
  void quiet(recorder.start());
  // Error-triggered replay: the first error of a buffering session uploads its replay.
  cleanup.push(
    events.subscribe((name, _attrs, severity) => {
      if (name === "exception" && severity === "error") recorder?.onError();
    }),
  );

  // ---- lifecycle flushes ----
  const flush = (): Promise<void> =>
    quiet(
      // Console errors are reported one microtask late (errors/install.ts): let them land first.
      Promise.resolve().then(() => Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), chunker.flush()])),
    );
  // Registered after web-vitals so final vitals emitted on hide are included in the flush.
  const onVisibility = guard((): void => {
    if (document.visibilityState === "hidden") {
      tracker.endAll("hidden");
      void quiet(loggerProvider.forceFlush());
      void quiet(tracerProvider.forceFlush());
      void quiet(chunker.flush());
    }
  });
  const onPageHide = guard((): void => {
    // Open click and soft-navigation spans end now so the flush below carries them.
    tracker.endAll("hidden");
    void quiet(loggerProvider.forceFlush());
    void quiet(tracerProvider.forceFlush());
    void quiet(chunker.flush({ keepalive: true }));
    session.stop();
  });
  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("pagehide", onPageHide);
  cleanup.push(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener("pagehide", onPageHide);
  });

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

  let stopped: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    stopped ??= (async () => {
      await flush();
      // Reverse order of installation; the providers' shutdown (last pushed first) flushes again.
      const pending: unknown[] = [];
      for (const off of cleanup.reverse()) pending.push(attempt(off));
      await quiet(Promise.all(pending));
      setGuardReporter(undefined);
      if (instance === rum) instance = undefined;
      logger.log("shut down");
    })();
    return stopped;
  };

  const rum: RUM & { _uninstall(): Promise<void> } = {
    // Public methods are called by the app: they never throw into it.
    setUser(user: UserOptions): void {
      attempt(() => {
        session.setUser(user.id);
        logger.log("user set", user.id);
      });
    },
    captureError(err: unknown, context?: Attrs): void {
      attempt(() => {
        claimError(err);
        events.emit("exception", exceptionAttributes(err, "captured", context), "error");
      });
    },
    addEvent(name: string, attrs?: Attrs): void {
      attempt(() => events.emit(name, { ...(attrs ?? {}), "ouo.event.custom": true }));
    },
    setRoute(name: string): void {
      attempt(() => {
        route.name = name || undefined;
        if (name) tracker.current("navigation")?.span.setAttribute("app.screen.name", name);
      });
    },
    replay: {
      pause: () => attempt(() => recorder?.pause()),
      resume: () => attempt(() => recorder?.resume()),
      isRecording: () => attempt(() => recorder?.isRecording() ?? false, false),
    },
    session: {
      id: () => attempt(() => session.id(), ""),
      userId: () => attempt(() => session.userId(), ""),
    },
    flush,
    shutdown,
    _uninstall: shutdown,
  };
  return rum;
}
