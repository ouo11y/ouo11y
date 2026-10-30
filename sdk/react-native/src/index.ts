import { installShims } from "./shims";
// Shims first: the OTel browser builds read performance.timeOrigin and TextEncoder at call time,
// but installing before anything else keeps the order obvious.
const shims = installShims();

import { context, diag, DiagLogLevel, propagation, trace, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
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
import type { TrackTouch } from "./provider";
import type { Gesture } from "./taps";
import { basicAuthorization, ingestHeaders, requireCredentials, resolveEndpoints } from "./endpoints";
import { installFetchInstrumentation, installXhrInstrumentation } from "./network";
import { createReplayController, loadNativeReplayModule } from "./replay";
import { SampledLogProcessor, SampledSpanProcessor, sampleRate } from "./sampling";
import { SessionManager } from "./session/manager";
import { MemoryAsyncStorage, safeStorage } from "./session/storage";
import { StackContextManager } from "./telemetry/context";
import { SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { SessionPropagator } from "./telemetry/propagator";
import { buildResource } from "./telemetry/resource";
import { createLogExporter, createTraceExporter } from "./transport/exporter";
import { Outbox } from "./transport/outbox";
import { createSend, type NativeOtlpPost } from "./transport/send";
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
export { touchedComponent, type FiberLike, type Gesture, type TouchedComponent } from "./taps";
export { getRUM } from "./instance";
export { type NativeReplayModule, type NativeStartOptions } from "./replay";
export { sampled, samplingHash, SAMPLING_SALT } from "./sampling";
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
  /** RUMProvider: a touch ended (`ui.tap`, with the `timeline.tapLabels` kill switch applied). */
  _trackTouch: TrackTouch;
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

  // One load for vitals, OTLP gzip and replay; undefined in Expo Go, on web and in tests.
  const nativeModule = loadNativeReplayModule();

  // ---- delivery (C11): every OTLP batch is persisted, then sent gzip by the native module ----
  const offline = options.transport?.offline;
  const outbox = new Outbox({
    // Unwrapped: the outbox tells a failed read from an empty store and guards its own calls.
    storage: offline === false ? new MemoryAsyncStorage() : (options.storage ?? AsyncStorage),
    send: createSend(ingestHeaders(authorization), nativeModule as Partial<NativeOtlpPost> | undefined),
    logger,
    ...(offline && offline.maxBytes !== undefined ? { maxBytes: offline.maxBytes } : {}),
  });

  // ---- replay (native, ADR-0006; chunks go to the collector's replay receiver with the Basic credential, ADR-0007) ----
  const sessionSampleRate = sampleRate(options.session?.sampleRate, 1);
  const replay = createReplayController({
    endpoint: endpoints.replayEndpoint,
    projectId,
    projectToken,
    options: options.replay,
    sessionSampleRate,
    storage,
    logger,
  });

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
      nativeCrash.setSessionId(next.id, next.startedAt);
    },
  });

  const resource = buildResource(options.service, options.device, options.resource);

  // ---- logs (events) ----
  const logExporter = createLogExporter(endpoints.logs, outbox);
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new SessionLogProcessor(session, serviceVersion),
      // Session sampling (8b): records of a session outside the sample are never exported.
      new SampledLogProcessor(
        new BatchLogRecordProcessor({
          exporter: logExporter,
          scheduledDelayMillis: 1000,
          maxExportBatchSize: 64,
          maxQueueSize: 2048,
          exportTimeoutMillis: 10000,
        }),
        sessionSampleRate,
      ),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  events = new EventEmitter(loggerProvider.getLogger(SDK_NAME, SDK_VERSION), logger);

  // ---- traces ----
  const traceExporter = createTraceExporter(endpoints.traces, outbox);
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new SessionSpanProcessor(session, serviceVersion),
      new SampledSpanProcessor(
        new BatchSpanProcessor(traceExporter, {
          scheduledDelayMillis: 2000,
          maxExportBatchSize: 64,
          maxQueueSize: 1024,
          exportTimeoutMillis: 10000,
        }),
        sessionSampleRate,
      ),
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
    replay.onError();
    const link = linker.contextFor(error);
    if (!link) {
      events.emit("exception", attrs, "error");
      return;
    }
    events.emit("exception", { ...attrs, "ouo.exception.trace_link": link.link }, "error", Date.now(), { context: link.context });
  };
  const timeline = {
    taps: options.timeline?.taps !== false,
    tapLabels: options.timeline?.tapLabels !== false,
    appLifecycle: options.timeline?.appLifecycle !== false,
    requests: options.timeline?.requests !== false,
  };

  const flush = async (): Promise<void> => {
    session.persistNow();
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), replay.flush()]);
    // The batches are persisted by now; this tries to send them (and what earlier runs left).
    await outbox.drain();
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
    native: vitalsOn ? (nativeModule as NativeVitalsModule | undefined) : undefined,
    ...(options.vitals ? { options: options.vitals } : {}),
    launchedInForeground: AppState.currentState === "active",
  });

  // ---- session ----
  const ready = session.start().then(() => {
    vitals.sessionReady();
    // What earlier runs could not send: OTLP batches, and the replay chunks they held.
    void outbox.drain();
    const ended = session.peekLastEnded();
    void replay.decideHeld(session.id(), ended?.endReason === "crash" ? ended.id : undefined);
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
  nativeCrash.install(session.id(), session.startedAt());

  // ---- instrumentation ----
  // The SDK's own uploads are never traced: the OTLP exports and the replay chunks.
  const ignoreUrls: Array<RegExp | string> = [
    new RegExp(`^${escapeRegExp(endpoints.traces)}(?:[/?#]|$)`),
    new RegExp(`^${escapeRegExp(endpoints.logs)}(?:[/?#]|$)`),
    new RegExp(`^${escapeRegExp(endpoints.replayChunks)}(?:[/?#]|$)`),
    // Dev only: LogBox asks Metro to symbolicate every error stack, and @sentry/react-native asks
    // its Metro middleware for source context; those are not app requests (they were spans and
    // timeline requests after a crashed session's session.end, checklist Q1).
    ...(isDev() ? [METRO_DEV_ENDPOINTS] : []),
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
      // Back in the foreground: the network may be back too.
      void outbox.drain();
    },
  });

  const navigation = createNavigationTracker((attrs) => {
    events.emit("navigation", { ...attrs, "ouo.navigation.kind": "screen" });
    onActivity();
    replay.screenDidChange();
    vitals.navigated(screenName(String(attrs["url.path"] ?? "")));
  });

  // `ui.tap` at the touch start; the body is the user step as a person reads it.
  const emitTap = (target: string, path: string | undefined, gesture: Gesture, viewType: string | undefined, at: number): void => {
    if (!timeline.taps || !target) return;
    const screen = screenName(navigation.current());
    const attrs: Attrs = { "ouo.ui.target": target, "ouo.ui.gesture": gesture };
    if (path && path !== target) attrs["ouo.ui.path"] = path;
    if (viewType) attrs["ouo.ui.view_type"] = viewType;
    if (screen) attrs["app.screen.name"] = screen;
    events.emit("ui.tap", attrs, "info", at, { body: userStep(gesture, target, viewType, screen) });
  };

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
    sampling: { session: sessionSampleRate, replay: options.replay?.sampleRate ?? 1, replayOnError: options.replay?.onErrorSampleRate ?? 0 },
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
    trackTap(target: string, path?: string, gesture: Gesture = "tap"): void {
      onActivity();
      emitTap(target, path, gesture, undefined, Date.now());
    },
    _trackTouch(touched, gesture, startedAt): void {
      // Labels off: what was touched (its view type), not what it is called.
      if (timeline.tapLabels) emitTap(touched.target, touched.path, gesture, touched.viewType, startedAt);
      else emitTap(touched.viewType, undefined, gesture, touched.viewType, startedAt);
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
      outbox.stop();
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

/** `app.screen.name`: the route name, the last segment of a navigation path. */
function screenName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const GESTURE_WORDS: Record<Gesture, string> = { tap: "Tap", long_press: "Long press", swipe: "Swipe" };

/** `Tap add-to-cart (button) on Products`. */
function userStep(gesture: Gesture, target: string, viewType?: string, screen?: string): string {
  return `${GESTURE_WORDS[gesture]} ${target}${viewType && viewType !== target ? ` (${viewType})` : ""}${screen ? ` on ${screen}` : ""}`;
}

/** Metro dev-server endpoints: `POST /symbolicate` (LogBox), `POST /__sentry/context` (Sentry's middleware). */
export const METRO_DEV_ENDPOINTS = /^https?:\/\/[^/]+\/(?:symbolicate|__sentry\/[^?#]*)(?:[?#]|$)/;

function isDev(): boolean {
  return (globalThis as { __DEV__?: unknown }).__DEV__ === true;
}

/** react-navigation helper: `<NavigationContainer onStateChange={navigationStateListener(rum)}>`. */
export function navigationStateListener(rum: RUM): (state: NavigationStateLike | undefined) => void {
  // Straight through to the instance tracker so `ouo.navigation.from` and de-duplication
  // use the same state as `rum.trackNavigation`.
  return (state) => rum.trackNavigation(activeRoutePath(state));
}
