import { context, diag, DiagLogLevel, propagation, trace, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
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
import { createConsentGate, type Gated, type Installed } from "./consent";
import { basicAuthorization, deriveIngestUrls, ingestHeaders } from "./ingest";
import { attempt, guard, quiet, setGuardReporter } from "./guard";
import { createDelivery, createLogExporter, createTraceExporter } from "./transport";
import { createLogger } from "./logger";
import { installNavigation } from "./navigation";
import { createNetworkInstrumentations } from "./network";
import { ReplayChunker } from "./replay/chunker";
import { ReplayRecorder, UNMASK_CLASS } from "./replay/recorder";
import { createChunkUploader } from "./replay/uploader";
import { loadDeviceId } from "./session/device";
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
export { CONSENT_QUEUE_LIMIT } from "./consent";

let instance: Gated | undefined;

/** The instance `initRUM` returned, or undefined before it was called (framework integrations use it). */
export function getRUM(): RUM | undefined {
  return instance;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What `initRUM` returns where it cannot run (no `window`, server rendering) or failed to start. */
function noopRUM(): Gated {
  const done = (): Promise<void> => Promise.resolve();
  return {
    setConsent: done,
    getConsent: () => ({ status: "pending", telemetry: false, replay: false }),
    setUser: () => undefined,
    clearUser: () => undefined,
    endSession: () => undefined,
    captureError: () => undefined,
    addEvent: () => undefined,
    setRoute: () => undefined,
    replay: { pause: () => undefined, resume: () => undefined, isRecording: () => false },
    session: { id: () => "", userId: () => "", deviceId: () => "" },
    flush: done,
    shutdown: done,
    deliveryStats: () => ({ sent: 0, retried: 0, queued: 0, dropped: 0, droppedBytes: 0, dropReasons: {}, rawBytes: 0, wireBytes: 0 }),
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

  const start = (replay: boolean): Installed | undefined => {
    const cleanup: Array<() => unknown> = [];
    try {
      return install(options, urls, authorization, cleanup, replay);
    } catch (err) {
      console.warn("[ouo] could not start, the SDK is off", err);
      for (const off of cleanup.reverse()) attempt(off);
      setGuardReporter(undefined);
      return undefined;
    }
  };
  // Consent pending: nothing below `install` runs, so nothing is stored, opened or sent (README, "Consent").
  let running: Installed | undefined;
  if (options.consent !== "pending") {
    running = start(true);
    if (!running) return noopRUM();
  }
  const gate: Gated = createConsentGate(
    start,
    createLogger(options.debug === true),
    () => {
      if (instance === gate) instance = undefined;
    },
    running,
  );
  instance = gate;
  return gate;
}

function install(
  options: RUMOptions,
  urls: ReturnType<typeof deriveIngestUrls>,
  authorization: string,
  cleanup: Array<() => unknown>,
  /** Replay consent: without it the recorder starts paused and rrweb is never loaded. */
  replayAllowed: boolean,
): Installed {
  const authHeaders = ingestHeaders(authorization);
  const logger = createLogger(options.debug === true);
  setGuardReporter((err) => logger.warn("contained", err));
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

  // Before the lifecycle handlers below: it marks the page hidden before their flush runs.
  const delivery = createDelivery(options.transport, logger);
  // First in, last out: closed after the providers' final flush.
  cleanup.push(() => delivery.close());

  const serviceVersion = options.service.version;
  const storage = new LocalStorage();
  const deviceId = loadDeviceId(storage);

  // Late-bound: the session manager emits session.start inside start(), after these exist.
  let events: EventEmitter;
  let recorder: ReplayRecorder | undefined;

  const session = new SessionManager({
    storage,
    ...(options.session?.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: options.session.inactivityTimeoutMs } : {}),
    ...(options.session?.maxDurationMs !== undefined ? { maxDurationMs: options.session.maxDurationMs } : {}),
    ...(options.user?.id ? { initialUserId: options.user.id } : {}),
    deviceId,
    ...(options.session?.sampleRate !== undefined ? { sessionSampleRate: options.session.sampleRate } : {}),
    logger,
    onEvent: (event) => events.emit(event.name, event.attributes, "info"),
    onRotate: (next, previousId) => recorder?.onRotate(next, previousId),
  });

  const resource = buildResource(options.service, deviceId);
  const route = new RouteState();

  // ---- logs (events) ----
  const logExporter = createLogExporter({ url: urls.logs, headers: authHeaders, delivery });
  // Not the OTel BatchLogRecordProcessor: it drops a flush requested while one is running,
  // which loses what is emitted at page hide (src/telemetry/batch.ts).
  const logBatch = new PageLogRecordProcessor(logExporter, {
    scheduledDelayMillis: 1000,
    maxExportBatchSize: 64,
    maxQueueSize: 2048,
    onDrop: () => delivery.countQueueDrop("logs"),
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SessionLogProcessor(session, serviceVersion, route), new SampledLogProcessor(session, logBatch)],
  });
  if (logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider) cleanup.push(() => logs.disable());
  cleanup.push(() => loggerProvider.shutdown());
  events = new EventEmitter(loggerProvider.getLogger(SDK_NAME, SDK_VERSION), logger);

  // ---- traces ----
  const traceExporter = createTraceExporter({ url: urls.traces, headers: authHeaders, delivery });
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
          onDrop: () => delivery.countQueueDrop("traces"),
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
      // Click labels follow the replay's text masking (ADR-0003 revision 2026-11-03).
      unmask: options.replay?.maskAllText === false ? undefined : `.${UNMASK_CLASS}${options.replay?.unmaskTextSelector ? `,${options.replay.unmaskTextSelector}` : ""}`,
      mask: options.replay?.maskTextSelector,
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
    upload: createChunkUploader({ replayEndpoint: urls.replayEndpoint, authorization, logger, delivery }),
    ...(options.replay?.flushIntervalMs !== undefined ? { flushIntervalMs: options.replay.flushIntervalMs } : {}),
    ...(options.replay?.maxChunkBytes !== undefined ? { maxChunkBytes: options.replay.maxChunkBytes } : {}),
    logger,
  });
  cleanup.push(() => chunker.stop());
  recorder = new ReplayRecorder({
    enabled: replayEnabled,
    sampleRate: options.replay?.sampleRate ?? 1,
    onErrorSampleRate: options.replay?.onErrorSampleRate ?? 0,
    onSkip: (reason, bytes) => events.emit("ouo.replay.skipped", { "ouo.replay.skip_reason": reason, "ouo.replay.snapshot_bytes": bytes }, "warn"),
    privacy: options.replay,
    onHidden: () => events.emit("ouo.replay.hidden", { "ouo.replay.hidden_reason": "route" }),
    session,
    chunker,
    logger,
  });
  const rec = recorder;
  cleanup.push(() => rec.shutdown());
  if (!replayAllowed) recorder.pause();
  void quiet(recorder.start());
  // Error-triggered replay: the first error of a buffering session uploads its replay.
  // Never-record routes: a navigation is emitted synchronously from the history call.
  cleanup.push(
    events.subscribe((name, _attrs, severity) => {
      if (name === "navigation") recorder?.onRoute();
      if (name === "exception" && severity === "error") recorder?.onError();
    }),
  );

  // ---- lifecycle flushes ----
  const flush = (): Promise<void> =>
    quiet(
      // Console errors are reported one microtask late (errors/install.ts): let them land first.
      Promise.resolve().then(() => Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), chunker.flush()])),
    );
  const flushHidden = (keepalive: boolean): void => {
    // Open click and soft-navigation spans end now so the flush carries them.
    tracker.endAll("hidden");
    void quiet(Promise.all([loggerProvider.forceFlush(), tracerProvider.forceFlush(), chunker.flush({ keepalive })]));
  };
  // Registered after web-vitals so final vitals emitted on hide are included in the flush.
  const onVisibility = guard((): void => {
    if (document.visibilityState === "hidden") flushHidden(false);
  });
  const onPageHide = guard((): void => {
    flushHidden(true);
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
      logger.log("shut down");
    })();
    return stopped;
  };

  const rum: Installed = {
    // Public methods are called by the app: they never throw into it.
    setUser(user: UserOptions): void {
      attempt(() => {
        session.setUser(user.id);
        logger.log("user set", user.id);
      });
    },
    clearUser(): void {
      attempt(() => {
        session.clearUser();
        logger.log("user cleared", session.userId());
      });
    },
    endSession(): void {
      attempt(() => session.endSession());
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
      deviceId: () => deviceId,
    },
    flush,
    shutdown,
    _uninstall: shutdown,
    _revoke: () => {
      // Before the shutdown's flush: what is still buffered is dropped, not sent or stored.
      delivery.halt();
      return shutdown();
    },
    deliveryStats: () => ({ ...delivery.stats, dropReasons: { ...delivery.stats.dropReasons } }),
  };
  return rum;
}
