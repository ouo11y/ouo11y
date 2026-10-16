import { installShims } from "./shims";
// Shims first: the OTel browser builds read performance.timeOrigin and TextEncoder at call time,
// but installing before anything else keeps the order obvious.
const shims = installShims();

import { diag, DiagLogLevel, propagation, trace, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { installAppStateListener } from "./appstate";
import { exceptionAttributes, serializeError } from "./errors/classify";
import { installErrorCapture } from "./errors/install";
import { getRUM, setRUM } from "./instance";
import { createLogger } from "./logger";
import { activeRoutePath, createNavigationTracker, type NavigationStateLike } from "./navigation";
import { basicAuthorization, ingestHeaders, requireCredentials, resolveEndpoints } from "./endpoints";
import { installFetchInstrumentation, installXhrInstrumentation } from "./network";
import { createReplayController } from "./replay";
import { SessionManager } from "./session/manager";
import { safeStorage } from "./session/storage";
import { SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { SessionPropagator } from "./telemetry/propagator";
import { buildResource } from "./telemetry/resource";
import type { Attrs, RUM, RUMOptions, UserOptions } from "./types";
import { escapeRegExp } from "./url";
import { SDK_NAME, SDK_VERSION } from "./version";

export type * from "./types";
export { SDK_VERSION } from "./version";
export { RUMProvider, type RUMProviderProps } from "./provider";
export { activeRoutePath, type NavigationStateLike } from "./navigation";
export { getRUM } from "./instance";
export { type NativeReplayModule, type NativeStartOptions } from "./replay";
export {
  AUTHORIZATION_HEADER,
  DEFAULT_OTLP_PORT,
  DEFAULT_REPLAY_PORT,
  base64Encode,
  basicAuthorization,
  defaultReplayEndpoint,
  resolveEndpoints,
  type EndpointOptions,
  type ResolvedEndpoints,
} from "./endpoints";

/** Test / dev hook: tears everything down so initRUM can run again in the same process. */
export interface RUMInternal extends RUM {
  _uninstall(): Promise<void>;
}

/**
 * Initialise the ouo React Native SDK. Call once, as early as possible (the app entry
 * file). Returns the same instance on repeated calls. `rum.session.id()` is available
 * immediately; `rum.ready` resolves once the previous run's session was closed and
 * `session.start` was emitted.
 */
export function initRUM(options: RUMOptions): RUM {
  const existing = getRUM();
  if (existing) {
    console.warn("[ouo] initRUM called twice; returning the existing instance");
    return existing;
  }
  // Configuration errors throw: a missing credential means 401 on every request (ADR-0007).
  const endpoints = resolveEndpoints(options);
  const { projectId, projectToken } = requireCredentials(options);
  const authorization = basicAuthorization(projectId, projectToken);
  const logger = createLogger(options.debug === true);
  if (options.debug) {
    // Never console.error here: the SDK instruments console.error and would report its own diagnostics.
    const otelDiag: DiagLogger = {
      error: (...args) => console.warn("[ouo:otel]", ...args),
      warn: (...args) => console.warn("[ouo:otel]", ...args),
      info: (...args) => console.log("[ouo:otel]", ...args),
      debug: (...args) => console.log("[ouo:otel]", ...args),
      verbose: (...args) => console.log("[ouo:otel]", ...args),
    };
    diag.setLogger(otelDiag, DiagLogLevel.INFO);
  }
  logger.log("shims", shims);

  const serviceVersion = options.service.version;
  const storage = safeStorage(options.storage ?? AsyncStorage, (err) => logger.warn("storage error", err));

  // Late-bound: the session manager emits session events through this.
  let events: EventEmitter;

  // ---- replay (native, ADR-0006; chunks go to the collector's replay receiver with the Basic credential, ADR-0007) ----
  const replay = createReplayController({ endpoint: endpoints.replayEndpoint, projectId, projectToken, options: options.replay, logger });

  const session = new SessionManager({
    storage,
    ...(options.session?.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: options.session.inactivityTimeoutMs } : {}),
    ...(options.session?.maxDurationMs !== undefined ? { maxDurationMs: options.session.maxDurationMs } : {}),
    ...(options.session?.backgroundTimeoutMs !== undefined ? { backgroundTimeoutMs: options.session.backgroundTimeoutMs } : {}),
    ...(options.user?.id ? { initialUserId: options.user.id } : {}),
    serviceVersion,
    logger,
    onEvent: (event) => events.emit(event.name, event.attributes, "info", event.timestamp),
    onRotate: (next) => replay.sessionDidRotate(next.id),
  });

  const resource = buildResource(options.service, options.device);

  // ---- logs (events) ----
  const logExporter = new OTLPLogExporter({ url: endpoints.logs, headers: ingestHeaders(authorization) });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new SessionLogProcessor(session, serviceVersion),
      new BatchLogRecordProcessor({
        exporter: logExporter,
        scheduledDelayMillis: 1000,
        maxExportBatchSize: 64,
        maxQueueSize: 2048,
        exportTimeoutMillis: 10000,
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  events = new EventEmitter(loggerProvider.getLogger(SDK_NAME, SDK_VERSION), logger);

  // ---- traces ----
  const traceExporter = new OTLPTraceExporter({ url: endpoints.traces, headers: ingestHeaders(authorization) });
  const tracerProvider = new BasicTracerProvider({
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
  trace.setGlobalTracerProvider(tracerProvider);
  propagation.setGlobalPropagator(new SessionPropagator(session));
  const tracer = tracerProvider.getTracer(SDK_NAME, SDK_VERSION);

  const flush = async (): Promise<void> => {
    session.persistNow();
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), replay.flush()]);
  };
  const flushWithin = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      flush().then(
        () => {
          clearTimeout(t);
          resolve();
        },
        () => {
          clearTimeout(t);
          resolve();
        },
      );
    });

  // ---- session ----
  const ready = session.start().then(() => logger.log("session ready", session.id(), "previous", session.previousId() ?? null));
  const onActivity = (): void => session.touch();
  // The native recorder keys chunks by the session id it is told; rotations arrive through onRotate.
  replay.start(session.id());

  // ---- instrumentation ----
  // The SDK's own uploads are never traced: the OTLP exports and the replay chunks.
  const ignoreUrls: Array<RegExp | string> = [
    new RegExp(`^${escapeRegExp(endpoints.traces)}(?:[/?#]|$)`),
    new RegExp(`^${escapeRegExp(endpoints.logs)}(?:[/?#]|$)`),
    new RegExp(`^${escapeRegExp(endpoints.replayChunks)}(?:[/?#]|$)`),
    ...(options.tracing?.ignoreUrls ?? []),
  ];
  const networkOptions = {
    tracer,
    events,
    logger,
    propagateTo: options.tracing?.propagateTo ?? [],
    ignoreUrls,
    onActivity,
  };
  const uninstallFetch = installFetchInstrumentation(networkOptions);
  // axios and other XHR clients; fetch's own XHR is skipped (traced by the fetch wrapper).
  const uninstallXhr = installXhrInstrumentation(networkOptions);

  const fatalFlushTimeoutMs = options.errors?.fatalFlushTimeoutMs ?? 2000;
  const uninstallErrors = installErrorCapture({
    events,
    logger,
    ...(options.errors?.consoleErrors !== undefined ? { consoleErrors: options.errors.consoleErrors } : {}),
    ...(options.errors?.onUnhandledRejection ? { onUnhandledRejection: options.errors.onUnhandledRejection } : {}),
    onFatal: async (error) => {
      const s = serializeError(error);
      logger.warn("fatal error, writing crash marker and flushing", s.type, s.message);
      await Promise.all([session.markCrash({ type: s.type, message: s.message }), flushWithin(fatalFlushTimeoutMs)]);
    },
  });

  const uninstallAppState = installAppStateListener({
    logger,
    onBackground: () => {
      session.onBackground();
      void flush();
    },
    onForeground: () => session.onForeground(),
  });

  const navigation = createNavigationTracker((attrs) => {
    events.emit("navigation", attrs);
    onActivity();
  });

  logger.log(`${SDK_NAME}@${SDK_VERSION} initialised`, {
    endpoint: endpoints.endpoint,
    traces: endpoints.traces,
    logs: endpoints.logs,
    replayChunks: replay.active ? endpoints.replayChunks : null,
    replayEndpointDerived: endpoints.replayEndpointDerived,
    projectId,
    projectToken: `${projectToken.slice(0, 8)}…`,
    session: session.id(),
    user: session.userId(),
  });

  const rum: RUMInternal = {
    setUser(user: UserOptions): void {
      session.setUser(user.id);
      logger.log("user set", user.id);
    },
    captureError(err: unknown, context?: Attrs): void {
      events.emit("exception", exceptionAttributes(err, "captured", false, context), "error");
    },
    addEvent(name: string, attrs?: Attrs): void {
      events.emit(name, { ...(attrs ?? {}), "ouo.event.custom": true });
    },
    trackNavigation(path: string, attrs?: Attrs): void {
      navigation.track(path, attrs);
    },
    recordActivity: onActivity,
    replay: {
      pause: () => replay.pause(),
      resume: () => replay.resume(),
      isRecording: () => replay.isRecording(),
    },
    session: {
      id: () => session.id(),
      userId: () => session.userId(),
      previousId: () => session.previousId(),
    },
    ready,
    flush,
    async _uninstall(): Promise<void> {
      uninstallFetch();
      uninstallXhr();
      uninstallErrors();
      uninstallAppState();
      replay.stop();
      session.stop();
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
      trace.disable();
      propagation.disable();
      logs.disable();
      setRUM(undefined);
    },
  };
  setRUM(rum);
  return rum;
}

/** react-navigation helper: `<NavigationContainer onStateChange={navigationStateListener(rum)}>`. */
export function navigationStateListener(rum: RUM): (state: NavigationStateLike | undefined) => void {
  // Straight through to the instance tracker so `ouo.navigation.from` and de-duplication
  // use the same state as `rum.trackNavigation`.
  return (state) => rum.trackNavigation(activeRoutePath(state));
}
