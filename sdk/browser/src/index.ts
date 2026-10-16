import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

import { installActivityListeners } from "./activity";
import { exceptionAttributes } from "./errors/classify";
import { installErrorCapture } from "./errors/install";
import { basicAuthorization, deriveIngestUrls, ingestHeaders } from "./ingest";
import { createLogger } from "./logger";
import { installNavigation } from "./navigation";
import { createNetworkInstrumentations } from "./network";
import { ReplayChunker } from "./replay/chunker";
import { ReplayRecorder } from "./replay/recorder";
import { createChunkUploader } from "./replay/uploader";
import { SESSION_STORAGE_KEY, SessionManager } from "./session/manager";
import { LocalStorage } from "./session/storage";
import { SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { SessionPropagator } from "./telemetry/propagator";
import { buildResource } from "./telemetry/resource";
import type { Attrs, RUM, RUMOptions, UserOptions } from "./types";
import { installWebVitals } from "./vitals";
import { SDK_NAME, SDK_VERSION } from "./version";

export type * from "./types";
export { SDK_VERSION } from "./version";
export type { ReplayChunk } from "./replay/chunker";
export { basicAuthorization, deriveIngestUrls, deriveReplayEndpoint, type IngestUrls } from "./ingest";

let instance: RUM | undefined;

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
    logger,
    onEvent: (event) => events.emit(event.name, event.attributes, "info"),
    onRotate: (next, previousId) => recorder?.onRotate(next, previousId),
  });

  const resource = buildResource(options.service);

  // ---- logs (events) ----
  const logExporter = new OTLPLogExporter({ url: urls.logs, headers: authHeaders });
  const logBatch = new BatchLogRecordProcessor({
    exporter: logExporter,
    scheduledDelayMillis: 1000,
    maxExportBatchSize: 64,
    maxQueueSize: 2048,
    exportTimeoutMillis: 10000,
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SessionLogProcessor(session, serviceVersion), logBatch],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  events = new EventEmitter(loggerProvider.getLogger(SDK_NAME, SDK_VERSION), logger);

  // ---- traces ----
  const traceExporter = new OTLPTraceExporter({ url: urls.traces, headers: authHeaders });
  const tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new SessionSpanProcessor(session, serviceVersion),
      new BatchSpanProcessor(traceExporter, {
        scheduledDelayMillis: 2000,
        maxExportBatchSize: 64,
        maxQueueSize: 1024,
        exportTimeoutMillis: 10000,
      }),
    ],
  });
  tracerProvider.register({ propagator: new SessionPropagator(session) });

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
  const uninstallNavigation = installNavigation({ events, onActivity });
  try {
    installWebVitals(events);
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
    session,
    chunker,
    logger,
  });
  void recorder.start();

  // ---- lifecycle flushes ----
  const flush = async (): Promise<void> => {
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), chunker.flush()]);
  };
  // Registered after web-vitals so final vitals emitted on hide are included in the flush.
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      void loggerProvider.forceFlush();
      void tracerProvider.forceFlush();
      void chunker.flush();
    }
  };
  const onPageHide = (): void => {
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
      events.emit("exception", exceptionAttributes(err, "captured", context), "error");
    },
    addEvent(name: string, attrs?: Attrs): void {
      events.emit(name, { ...(attrs ?? {}), "ouo.event.custom": true });
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
      globalThis.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("pagehide", onPageHide);
      recorder?.pause();
      chunker.stop();
      session.stop();
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
      instance = undefined;
    },
  };
  instance = rum;
  return rum;
}
