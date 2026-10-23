import { installShims } from "./shims";
// Shims first: the OTel browser builds read performance.timeOrigin and TextEncoder at call time,
// but installing before anything else keeps the order obvious.
const shims = installShims();

import { context, diag, DiagLogLevel, propagation, trace, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";

import { installAppStateListener } from "./appstate";
import { crashMarker, createNativeCrashCapture, isReactNativeFatal, nativeCrashAttributes } from "./crash";
import { exceptionAttributes, serializeError } from "./errors/classify";
import { ReportedErrors } from "./errors/dedupe";
import { installErrorCapture } from "./errors/install";
import { forwardSentryErrors } from "./errors/sentry";
import { getRUM, setRUM } from "./instance";
import { createLogger } from "./logger";
import { activeRoutePath, createNavigationTracker, type NavigationStateLike } from "./navigation";
import { basicAuthorization, ingestHeaders, requireCredentials, resolveEndpoints } from "./endpoints";
import { installFetchInstrumentation, installXhrInstrumentation } from "./network";
import { createReplayController, loadNativeReplayModule } from "./replay";
import { SessionManager } from "./session/manager";
import { safeStorage } from "./session/storage";
import { StackContextManager } from "./telemetry/context";
import { SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { SessionPropagator } from "./telemetry/propagator";
import { buildResource } from "./telemetry/resource";
import { createLogApi, createSpanApi, TraceLinker } from "./tracing";
import type { Attrs, RUM, RUMOptions, UserOptions } from "./types";
import { escapeRegExp } from "./url";
import { createVitals, type NativeVitalsModule } from "./vitals";
import { SDK_NAME, SDK_VERSION } from "./version";

export type * from "./types";
export { SDK_VERSION } from "./version";
export { RUMProvider, type RUMProviderProps } from "./provider";
export { activeRoutePath, type NavigationStateLike } from "./navigation";
export { normalizeStack, type NormalizedStack, type StackFrame } from "./errors/stack";
export { touchedComponent, type FiberLike, type TouchedComponent } from "./taps";
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
  /** RUMProvider mounted: the app's first frame follows (vitals). */
  _rootMounted(): void;
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

  // ---- native crashes (signals, uncaught NSExceptions): the previous run's report, taken once ----
  const nativeCrash = createNativeCrashCapture({ enabled: options.errors?.nativeCrashes !== false, logger });
  const crashed = nativeCrash.pending;

  const session = new SessionManager({
    storage,
    ...(options.session?.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: options.session.inactivityTimeoutMs } : {}),
    ...(options.session?.maxDurationMs !== undefined ? { maxDurationMs: options.session.maxDurationMs } : {}),
    ...(options.session?.backgroundTimeoutMs !== undefined ? { backgroundTimeoutMs: options.session.backgroundTimeoutMs } : {}),
    ...(options.user?.id ? { initialUserId: options.user.id } : {}),
    serviceVersion,
    logger,
    ...(crashed ? { nativeCrash: crashMarker(crashed) } : {}),
    onEvent: (event) => events.emit(event.name, event.attributes, "info", event.timestamp),
    onRotate: (next) => {
      replay.sessionDidRotate(next.id);
      nativeCrash.setSessionId(next.id);
    },
  });

  const resource = buildResource(options.service, options.device, options.resource);

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
  // Synchronous context, so spans of withSpan parent the requests, logs and errors inside it.
  context.setGlobalContextManager(new StackContextManager());
  const tracer = tracerProvider.getTracer(SDK_NAME, SDK_VERSION);
  const linker = new TraceLinker();
  const spans = createSpanApi(tracer, linker);
  const log = createLogApi(events);

  // ---- exceptions: one record per error (dedupe), with the trace it belongs to (G5) ----
  const reported = new ReportedErrors();
  const emitException = (error: unknown, attrs: Attrs): void => {
    const link = linker.contextFor(error);
    if (!link) {
      events.emit("exception", attrs, "error");
      return;
    }
    events.emit("exception", { ...attrs, "ouo.exception.trace_link": link.link }, "error", Date.now(), { context: link.context });
  };
  const timeline = {
    taps: options.timeline?.taps !== false,
    appLifecycle: options.timeline?.appLifecycle !== false,
    requests: options.timeline?.requests !== false,
  };

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

  // ---- vitals (G2, docs/specs/mobile-vitals.md) ----
  const vitalsOn = options.vitals?.enabled !== false;
  const vitals = createVitals({
    events,
    logger,
    native: vitalsOn ? (loadNativeReplayModule() as NativeVitalsModule | undefined) : undefined,
    ...(options.vitals ? { options: options.vitals } : {}),
    launchedInForeground: AppState.currentState === "active",
  });

  // ---- session ----
  const ready = session.start().then(() => {
    vitals.sessionReady();
    logger.log("session ready", session.id(), "previous", session.previousId() ?? null);
    if (crashed && !isReactNativeFatal(crashed)) {
      // The crashed session's fatal exception (ADR-0004: crashed), stamped at the crash time. Its
      // session.end (reason crash, same time) was emitted by the cold start just before.
      const attrs = nativeCrashAttributes(crashed);
      const ended = session.peekLastEnded();
      if (ended && ended.id === crashed.session_id && ended.serviceVersion !== undefined) attrs["service.version"] = ended.serviceVersion;
      events.emit("exception", attrs, "error", crashed.timestamp_ms);
      logger.warn("native crash of the previous run reported", crashed.session_id, attrs["exception.message"]);
    }
  });
  const onActivity = (): void => session.touch();
  // The native recorder keys chunks by the session id it is told; rotations arrive through onRotate.
  replay.start(session.id());
  // After Sentry.init when both run: ouo's handlers then run first and chain to Sentry's.
  nativeCrash.install(session.id());

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
    requestEvents: timeline.requests,
    linker,
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
    reported,
    emitException,
    onFatal: async (error) => {
      const s = serializeError(error);
      logger.warn("fatal error, writing crash marker and flushing", s.type, s.message);
      await Promise.all([session.markCrash({ type: s.type, message: s.message }), flushWithin(fatalFlushTimeoutMs)]);
    },
  });

  // Opt-in (G6): after installErrorCapture, so ouo's own captures are known when Sentry sends them.
  const sentryClient = options.errors?.forwardSentryErrors;
  const uninstallSentry = sentryClient ? forwardSentryErrors({ client: sentryClient, reported, logger, emitException }) : () => {};

  const uninstallAppState = installAppStateListener({
    logger,
    ...(timeline.appLifecycle
      ? { onLifecycle: (state: string) => events.emit("app.lifecycle", { "ouo.app.state": state }, "info", Date.now(), { body: `app ${state}` }) }
      : {}),
    onBackground: () => {
      vitals.background();
      session.onBackground();
      void flush();
    },
    onForeground: () => {
      session.onForeground();
      vitals.foreground();
    },
  });

  const navigation = createNavigationTracker((attrs) => {
    events.emit("navigation", attrs);
    onActivity();
    // `app.screen.name`: the route name, the last segment of the path.
    const path = String(attrs["url.path"] ?? "");
    vitals.navigated(path.slice(path.lastIndexOf("/") + 1));
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
      reported.add(err);
      emitException(err, exceptionAttributes(err, "captured", false, context));
    },
    addEvent(name: string, attrs?: Attrs): void {
      events.emit(name, { ...(attrs ?? {}), "ouo.event.custom": true });
    },
    trackNavigation(path: string, attrs?: Attrs): void {
      navigation.track(path, attrs);
    },
    recordActivity: onActivity,
    trackTap(target: string, path?: string): void {
      onActivity();
      if (!timeline.taps || !target) return;
      const attrs: Attrs = { "ouo.ui.target": target };
      if (path && path !== target) attrs["ouo.ui.path"] = path;
      events.emit("ui.tap", attrs, "info", Date.now(), { body: path || target });
    },
    startSpan: spans.startSpan,
    withSpan: spans.withSpan,
    log,
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
    _rootMounted: () => vitals.rootMounted(),
    async _uninstall(): Promise<void> {
      vitals.stop();
      uninstallFetch();
      uninstallXhr();
      uninstallErrors();
      uninstallSentry();
      uninstallAppState();
      replay.stop();
      session.stop();
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
      trace.disable();
      propagation.disable();
      context.disable();
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
