import { installShims } from "./shims";
// Shims first: the OTel browser builds read performance.timeOrigin and TextEncoder at call time,
// but installing before anything else keeps the order obvious.
const shims = installShims();

import { context, diag, DiagLogLevel, propagation, ProxyTracerProvider, trace, type DiagLogger, type Span, type TracerProvider } from "@opentelemetry/api";
import { createNoopLogger, logs, type LoggerProvider as LoggerProviderApi } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";

import { installAppStateListener } from "./appstate";
import { appAttributes, isReservedName, primitiveAttributes } from "./attributes";
import { normalizeOptions } from "./config";
import { crashMarker, createNativeCrashCapture, isReactNativeFatal, nativeCrashAttributes, type NativeCrashModule } from "./crash";
import { DROP_EVENT, DropCounter } from "./drops";
import { exceptionAttributes, serializeError } from "./errors/classify";
import {
  CONTEXT_STORAGE_KEY,
  ContextPersister,
  deviceContextAttributes,
  deviceLocale,
  parseScreenContext,
  screenContextAttributes,
  type NativeErrorContextModule,
} from "./errors/context";
import { feedbackRecord } from "./feedback";
import { ReportedErrors } from "./errors/dedupe";
import { installErrorCapture } from "./errors/install";
import { forwardSentryErrors } from "./errors/sentry";
import { guard, guardNative } from "./guard";
import { getRUM, setRUM } from "./instance";
import { createLogger } from "./logger";
import { createUrlSanitizer } from "./privacy";
import { activeRoutePath, createNavigationTracker, type NavigationStateLike } from "./navigation";
import { gestureOf, type Gesture, type TouchEventLike, type TouchedComponent } from "./taps";
import { basicAuthorization, ingestHeaders } from "./endpoints";
import { installFetchInstrumentation, installXhrInstrumentation } from "./network";
import { createReplayController, loadNativeReplayModule } from "./replay";
import { SampledLogProcessor, SampledSpanProcessor } from "./sampling";
import { guardedClock } from "./session/clock";
import { uuidv4 } from "./session/ids";
import { SessionManager } from "./session/manager";
import { MemoryAsyncStorage, safeStorage, withTimeout } from "./session/storage";
import { sdkContext } from "./telemetry/context";
import { SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { guarded, LogGate, SpanGate } from "./telemetry/gate";
import { SessionPropagator } from "./telemetry/propagator";
import { lastEventsAttribute, RecentEvents } from "./telemetry/recent";
import { buildResource } from "./telemetry/resource";
import { createLogExporter, createTraceExporter } from "./transport/exporter";
import { Outbox } from "./transport/outbox";
import { createSend, type NativeOtlpPost } from "./transport/send";
import { createLogApi, createSpanApi, noopSpan, TraceLinker } from "./tracing";
import type { AsyncKeyValueStorage, Attrs, RUM, RUMLog, RUMOptions, SpanOptions, UserOptions } from "./types";
import { escapeRegExp } from "./url";
import { createVitals, type NativeVitalsModule } from "./vitals";
import { SDK_NAME, SDK_VERSION } from "./version";

export type * from "./types";
export { SDK_VERSION, SPEC_VERSION } from "./version";
export { RUMProvider, type RUMProviderProps } from "./provider";
export { activeRoutePath, type NavigationStateLike } from "./navigation";
export { normalizeStack, type NormalizedStack, type StackFrame } from "./errors/stack";
export { touchedComponent, type FiberLike, type Gesture, type TouchedComponent } from "./taps";
export { getRUM } from "./instance";
export { type NativeReplayModule, type NativeStartOptions } from "./replay";
export { sampled, samplingHash, SAMPLING_SALT } from "./sampling";
export { DROP_EVENT, type DropReason, type DropSignal } from "./drops";
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
  /** Like `shutdown()` but the session stays open: the next `initRUM` in this process resumes it. */
  _uninstall(): Promise<void>;
  /** RUMProvider mounted: the app's first frame follows (vitals). */
  _rootMounted(): void;
  /** RUMProvider: a touch started on `touched` (its screen and time are read now). */
  _touchStart(event: TouchEventLike, touched: TouchedComponent | undefined): void;
  /** RUMProvider: the touch ended or was cancelled: `ui.tap` with its gesture. */
  _touchEnd(event: TouchEventLike): void;
}

const GESTURES: readonly Gesture[] = ["tap", "long_press", "swipe"];
/** Attributes of `recordException` the app may set although they are in a reserved prefix (spec API-3, API-6). */
const EXCEPTION_SETTABLE: ReadonlySet<string> = new Set(["ouo.exception.fingerprint", "ouo.exception.handled"]);
const RESOLVED: Promise<void> = Promise.resolve();
const NOOP_TRACER_PROVIDER: TracerProvider = new ProxyTracerProvider();
const NOOP_LOGGER_PROVIDER: LoggerProviderApi = { getLogger: () => createNoopLogger() };

/**
 * What `init` returns when the SDK cannot run (invalid configuration, a failure while starting)
 * and what every instance behaves like after `shutdown()`: every function is a no-op that does
 * not throw (spec API-1, CFG-1). `withSpan` still runs the app's function.
 */
function noopRUM(): RUMInternal {
  const nothing = (): void => {};
  const log = Object.assign(nothing as unknown as RUMLog, { trace: nothing, debug: nothing, info: nothing, warn: nothing, error: nothing, fatal: nothing });
  return {
    setUser: nothing,
    setGlobalAttributes: nothing,
    recordException: nothing,
    captureError: nothing,
    recordEvent: nothing,
    addEvent: nothing,
    trackNavigation: nothing,
    recordActivity: nothing,
    trackTap: nothing,
    reportFullyDisplayed: nothing,
    startSpan: () => noopSpan(),
    withSpan: <T>(_name: string, fn: (span: Span) => T): T => (typeof fn === "function" ? fn(noopSpan()) : (undefined as T)),
    log,
    feedback: () => undefined,
    replay: { pause: nothing, resume: nothing, isRecording: () => false, hideScreen: nothing, showScreen: nothing, start: nothing, stop: nothing, capture: nothing, mask: nothing, unmask: nothing },
    session: { id: () => "", userId: () => "", previousId: () => undefined },
    ready: RESOLVED,
    flush: () => RESOLVED,
    getSessionId: () => undefined,
    restartSession: nothing,
    shutdown: () => RESOLVED,
    getTracerProvider: () => NOOP_TRACER_PROVIDER,
    getLoggerProvider: () => NOOP_LOGGER_PROVIDER,
    _uninstall: () => RESOLVED,
    _rootMounted: nothing,
    _touchStart: nothing,
    _touchEnd: nothing,
  };
}

/**
 * Initialise the ouo React Native SDK. Call once, as early as possible (the app entry
 * file). Returns the same instance on repeated calls. `rum.session.id()` is available
 * immediately; `rum.ready` resolves once the previous run's session was closed and
 * `session.start` was emitted.
 *
 * Never throws (spec CFG-1): with a missing or invalid `endpoint`, `projectId`, `projectToken`
 * or `service.name` it returns an instance whose every function is a no-op, and says why in the
 * console when `debug` is on. `init` is the spec's name for it.
 */
export function initRUM(options: RUMOptions): RUM {
  try {
    return start(options);
  } catch {
    // Reading the options failed in a way `start` could not report: still not the app's problem.
    return noopRUM();
  }
}

/** The spec's name for `initRUM` (API 3.1). */
export const init = initRUM;

function start(options: RUMOptions): RUM {
  const existing = getRUM();
  if (existing) {
    // LIF-1: ignored, with a diagnostic (only when `debug` is on, spec ERR-8).
    createLogger((options as { debug?: unknown } | null | undefined)?.debug === true).warn("init called twice; returning the existing instance");
    return existing;
  }
  const { config, diagnostics } = normalizeOptions(options);
  const logger = createLogger(config ? config.debug : (options as { debug?: unknown } | null | undefined)?.debug === true);
  for (const d of diagnostics) logger.warn(d);
  if (!config) return noopRUM();

  // What `shutdown`, a failed start and self-disable undo, in order.
  const hooks: Array<() => void> = [];
  const stopCapture = (): void => {
    for (const undo of hooks.splice(0)) guard.host("uninstall", undo);
  };
  let afterDisable: () => void = () => {};
  guard.reset({
    threshold: config.selfDisableThreshold,
    logger,
    // ERR-6: capture stops, every hook is removed, and every guarded function is a no-op from here.
    onDisable: () => {
      stopCapture();
      afterDisable();
    },
  });
  try {
    return build(config, logger, hooks, stopCapture, (fn) => (afterDisable = fn));
  } catch (err) {
    logger.warn("init failed; the SDK is a no-op", err);
    stopCapture();
    return noopRUM();
  }
}

function build(
  config: NonNullable<ReturnType<typeof normalizeOptions>["config"]>,
  logger: ReturnType<typeof createLogger>,
  hooks: Array<() => void>,
  stopCapture: () => void,
  onSelfDisable: (fn: () => void) => void,
): RUM {
  const { options, endpoints, projectId, projectToken } = config;
  const authorization = basicAuthorization(projectId, projectToken);
  if (config.debug) {
    // Never console.error here: the SDK instruments console.error and would report its own diagnostics.
    const otelDiag: DiagLogger = {
      error: (...args) => console.warn("[ouo:otel]", ...args),
      warn: (...args) => console.warn("[ouo:otel]", ...args),
      info: (...args) => console.log("[ouo:otel]", ...args),
      debug: (...args) => console.log("[ouo:otel]", ...args),
      verbose: (...args) => console.log("[ouo:otel]", ...args),
    };
    diag.setLogger(otelDiag, DiagLogLevel.INFO);
    hooks.push(() => diag.disable());
  }
  logger.log("shims", shims);

  const serviceVersion = config.service.version;
  const validStorage = (s: unknown): s is AsyncKeyValueStorage =>
    !!s && typeof (s as AsyncKeyValueStorage).getItem === "function" && typeof (s as AsyncKeyValueStorage).setItem === "function" && typeof (s as AsyncKeyValueStorage).removeItem === "function";
  if (options.storage !== undefined && !validStorage(options.storage)) logger.warn("storage is not an AsyncStorage-like object: using the default");
  const rawStorage: AsyncKeyValueStorage = validStorage(options.storage) ? options.storage : AsyncStorage;
  const storage = safeStorage(rawStorage, (err) => logger.warn("storage error", err));

  // PRV-10: every URL the SDK records goes through this first.
  const sanitizeUrl = createUrlSanitizer(config.urlPrivacy);

  // Every record the SDK drops, by signal and reason (ERR-7); reported as `ouo.sdk.dropped` below.
  const drops = new DropCounter();
  hooks.push(() => drops.stop());

  // Late-bound: the session manager emits session events through this.
  let events: EventEmitter;

  // One load for vitals, OTLP gzip, crash capture and replay; undefined in Expo Go, on web and in
  // tests. Every method of it runs inside the guard.
  const nativeModule = guardNative(loadNativeReplayModule());

  // ---- delivery (C11): every OTLP batch is persisted, then sent gzip by the native module ----
  const offline = options.transport?.offline;
  const maxBytes = offline && typeof offline === "object" && typeof offline.maxBytes === "number" && offline.maxBytes > 0 ? offline.maxBytes : undefined;
  const outbox = new Outbox({
    // Unwrapped: the outbox tells a failed read from an empty store and guards its own calls.
    storage: offline === false ? new MemoryAsyncStorage() : rawStorage,
    send: createSend(ingestHeaders(authorization), nativeModule as Partial<NativeOtlpPost> | undefined),
    logger,
    clock: guardedClock,
    drops,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });

  // ---- replay (native, ADR-0006; chunks go to the collector's replay receiver with the Basic credential, ADR-0007) ----
  const sessionSampleRate = config.session.sampleRate;
  const replayOptions = options.replay && typeof options.replay === "object" ? options.replay : undefined;
  const replay = createReplayController({
    endpoint: endpoints.replayEndpoint,
    projectId,
    projectToken,
    options: replayOptions,
    sessionSampleRate,
    native: nativeModule ?? null,
    storage,
    // The gap in the replay, on the session's timeline (the frame chunks have no event channel).
    onHidden: (reason) => events.emit("ouo.replay.hidden", { "ouo.replay.hidden_reason": reason }),
    logger,
  });

  // ---- native crashes (signals, uncaught NSExceptions) and foreground terminations: the previous
  // run's report, taken once; main-thread hangs arrive as events once they are over (C3) ----
  const nativeCrash = createNativeCrashCapture({
    enabled: options.errors?.nativeCrashes !== false,
    logger,
    native: (nativeModule as NativeCrashModule | undefined) ?? null,
    onHang: (report) => emitException(undefined, nativeCrashAttributes(report), report.timestamp_ms),
  });
  const crashed = nativeCrash.pending;

  const initialUserId = typeof options.user?.id === "string" && options.user.id ? options.user.id : undefined;
  const session = new SessionManager({
    storage,
    clock: guardedClock,
    inactivityTimeoutMs: config.session.inactivityTimeoutMs,
    maxDurationMs: config.session.maxDurationMs,
    backgroundTimeoutMs: config.session.backgroundTimeoutMs,
    ...(initialUserId ? { initialUserId } : {}),
    serviceVersion,
    logger,
    ...(crashed ? { nativeCrash: crashMarker(crashed) } : {}),
    onEvent: (event) => events.emit(event.name, event.attributes, "info", event.timestamp),
    onRotate: (next) => {
      replay.sessionDidRotate(next.id);
      nativeCrash.setSessionId(next.id, next.startedAt);
    },
  });

  const resource = buildResource(config.service, options.device && typeof options.device === "object" ? options.device : {}, primitiveAttributes(options.resource));
  // `setGlobalAttributes`: on every later span and log record.
  let globalAttributes: Attrs = {};
  const globals = (): Attrs => globalAttributes;

  // ---- logs (events) ----
  const logExporter = createLogExporter(endpoints.logs, outbox);
  // The session's last timeline events, for the records that carry them (feedback, exception).
  const recent = new RecentEvents();
  // Error context (C2): the previous run's screen and last events, read before this run persists
  // its own (AsyncStorage runs operations in order), for its crash or termination report.
  const previousContext = storage.getItem(CONTEXT_STORAGE_KEY).then(parseScreenContext, () => undefined);
  const screenContext = (sessionId: string) => ({ sessionId, screen: screenName(navigation.current()), events: recent.read(sessionId) });
  const contextPersister = new ContextPersister(storage, () => {
    const id = session.peek()?.id;
    return id ? screenContext(id) : undefined;
  });
  const locale = deviceLocale();
  // Every processor runs inside the guard. Order: session attributes, then the gate (`beforeSend`,
  // truncation), and only what passes it reaches the last-events buffer, the persisted context,
  // sampling and the batch queue.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      guarded(
        "processor.log",
        // The gate stamps the session attributes first: a record that cannot get them goes nowhere.
        new LogGate(new SessionLogProcessor(session, serviceVersion, globals), config.beforeSend, drops, logger, [
          recent,
          contextPersister,
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
            drops,
          ),
        ], sanitizeUrl),
        () => drops.count("log", "self_disabled"),
      ),
    ],
  });
  events = new EventEmitter(loggerProvider.getLogger(SDK_NAME, SDK_VERSION), logger);
  drops.onReport((list) => {
    for (const d of list) events.emit(DROP_EVENT, { "ouo.sdk.drop.reason": d.reason, "ouo.sdk.drop.signal": d.signal, "ouo.sdk.drop.count": d.count });
  });

  // ---- traces ----
  const traceExporter = createTraceExporter(endpoints.traces, outbox);
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      guarded("processor.session", new SessionSpanProcessor(session, serviceVersion, globals), () => {}),
      guarded(
        "processor.span",
        new SpanGate(
          config.beforeSend,
          drops,
          logger,
          new SampledSpanProcessor(
            new BatchSpanProcessor(traceExporter, {
              scheduledDelayMillis: 2000,
              maxExportBatchSize: 64,
              maxQueueSize: 1024,
              exportTimeoutMillis: 10000,
            }),
            sessionSampleRate,
            drops,
          ),
          sanitizeUrl,
        ),
        () => drops.count("span", "self_disabled"),
      ),
    ],
  });
  // REL-4: the SDK works on its own instances (provider, propagator, `sdkContext`). They become
  // the OpenTelemetry globals only when asked, and never in place of one the app registered.
  const propagator = new SessionPropagator(session, options.propagation?.sessionBaggage === true);
  if (config.registerGlobal) {
    if (trace.setGlobalTracerProvider(tracerProvider)) hooks.push(() => trace.disable());
    if (logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider) hooks.push(() => logs.disable());
    if (propagation.setGlobalPropagator(propagator)) hooks.push(() => propagation.disable());
    if (context.setGlobalContextManager(sdkContext)) hooks.push(() => context.disable());
  }
  const tracer = tracerProvider.getTracer(SDK_NAME, SDK_VERSION);
  const linker = new TraceLinker();

  // ---- exceptions: one record per error (dedupe), with the trace it belongs to (G5) ----
  const reported = new ReportedErrors();
  const emitException = (error: unknown, own: Attrs, at: number = Date.now()): void => {
    replay.onError();
    const attrs = { ...screenContextAttributes(screenContext(session.id())), ...deviceContextAttributes(locale, nativeModule as NativeErrorContextModule | undefined, logger), ...own };
    const link = linker.contextFor(error);
    if (!link) {
      events.emit("exception", attrs, "error", at);
      return;
    }
    events.emit("exception", { ...attrs, "ouo.exception.trace_link": link.link }, "error", at, { context: link.context });
  };
  // REL-7, SIG-33: an error that escapes `withSpan` is an `exception` log record with the span's
  // ids (the linker knows the span), not a span event. The app may still catch it: handled.
  const spans = createSpanApi(tracer, linker, (error) => {
    if (reported.add(error)) emitException(error, exceptionAttributes(error, "captured", false));
  });
  const log = createLogApi(events, (attrs) => appAttributes(attrs, drops));
  const timeline = {
    taps: options.timeline?.taps !== false,
    tapLabels: options.timeline?.tapLabels !== false,
    appLifecycle: options.timeline?.appLifecycle !== false,
    requests: options.timeline?.requests !== false,
  };

  const flushOnce = async (): Promise<void> => {
    session.persistNow();
    drops.flush();
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), replay.flush()]);
    // The batches are persisted by now; this tries to send them (and what earlier runs left).
    await outbox.drain();
  };
  // One at a time: the OTel batch processors return at once from a `forceFlush` made while
  // another is running, so a flush right after the background flush would resolve too early.
  let flushing: Promise<void> = RESOLVED;
  const flush = (): Promise<void> => (flushing = flushing.then(flushOnce, flushOnce));
  const flushWithin = (ms: number): Promise<void> => withTimeout(guard.run("flush", flush, RESOLVED), ms, undefined);

  // ---- vitals (G2, docs/specs/mobile-vitals.md) ----
  const vitalsOptions = options.vitals && typeof options.vitals === "object" ? options.vitals : undefined;
  const vitalsOn = vitalsOptions?.enabled !== false;
  const vitals = createVitals({
    events,
    logger,
    native: vitalsOn ? (nativeModule as NativeVitalsModule | undefined) : undefined,
    ...(vitalsOptions ? { options: vitalsOptions } : {}),
    launchedInForeground: AppState.currentState === "active",
  });
  hooks.push(() => vitals.stop(), () => nativeCrash.stop());

  // ---- session ----
  const ready = guard.run(
    "ready",
    () =>
      session.start().then(async () => {
        vitals.sessionReady();
        // What earlier runs could not send: OTLP batches, and the replay chunks they held.
        void outbox.drain();
        const ended = session.peekLastEnded();
        void guard.run("replay.held", () => replay.decideHeld(session.id(), ended?.endReason === "crash" ? ended.id : undefined));
        logger.log("session ready", session.id(), "previous", session.previousId() ?? null);
        if (crashed && !isReactNativeFatal(crashed)) {
          // The crashed session's fatal exception (ADR-0004: crashed), stamped at the crash time. Its
          // session.end (reason crash, same time) was emitted by the cold start just before.
          const attrs = nativeCrashAttributes(crashed);
          // The crashed run's context, as it persisted it (no memory or network: not measured now).
          const ctx = await previousContext;
          if (ctx && ctx.sessionId === (crashed.session_id || ctx.sessionId)) Object.assign(attrs, screenContextAttributes(ctx));
          if (locale) attrs["ouo.device.locale"] = locale;
          const ended = session.peekLastEnded();
          if (ended && ended.id === crashed.session_id && ended.serviceVersion !== undefined) attrs["service.version"] = ended.serviceVersion;
          events.emit("exception", attrs, "error", crashed.timestamp_ms);
          logger.warn(`native ${crashed.mechanism} of the previous run reported`, crashed.session_id);
        }
      }),
    RESOLVED,
  );
  const onActivity = (): void => session.touch();
  // The native recorder keys chunks by the session id it is told; rotations arrive through onRotate.
  replay.start(session.id());
  hooks.push(() => replay.stop());
  // After Sentry.init when both run: ouo's handlers then run first and chain to Sentry's.
  nativeCrash.install(session.id(), session.startedAt());

  // ---- instrumentation ----
  const patterns = (v: unknown): Array<RegExp | string> => (Array.isArray(v) ? v.filter((p) => typeof p === "string" || p instanceof RegExp) : []);
  // The SDK's own uploads are never traced: the OTLP exports and the replay chunks.
  const ignoreUrls: Array<RegExp | string> = [
    new RegExp(`^${escapeRegExp(endpoints.traces)}(?:[/?#]|$)`),
    new RegExp(`^${escapeRegExp(endpoints.logs)}(?:[/?#]|$)`),
    new RegExp(`^${escapeRegExp(endpoints.replayChunks)}(?:[/?#]|$)`),
    // Dev only: LogBox asks Metro to symbolicate every error stack, and @sentry/react-native asks
    // its Metro middleware for source context; those are not app requests (they were spans and
    // timeline requests after a crashed session's session.end, checklist Q1).
    ...(isDev() ? [METRO_DEV_ENDPOINTS] : []),
    ...patterns(options.tracing?.ignoreUrls),
  ];
  const networkOptions = {
    tracer,
    events,
    logger,
    propagateTo: patterns(options.tracing?.propagateTo),
    ignoreUrls,
    onActivity,
    requestEvents: timeline.requests,
    linker,
    propagator,
    sanitizeUrl,
  };
  hooks.push(installFetchInstrumentation(networkOptions));
  // axios and other XHR clients; fetch's own XHR is skipped (traced by the fetch wrapper).
  hooks.push(installXhrInstrumentation(networkOptions));

  const onUnhandledRejection = options.errors?.onUnhandledRejection;
  hooks.push(
    installErrorCapture({
      events,
      logger,
      ...(typeof options.errors?.consoleErrors === "boolean" ? { consoleErrors: options.errors.consoleErrors } : {}),
      ...(typeof onUnhandledRejection === "function" ? { onUnhandledRejection } : {}),
      reported,
      emitException,
      onFatal: async (error) => {
        const s = serializeError(error);
        logger.warn("fatal error, writing crash marker and flushing", s.type);
        await Promise.all([session.markCrash({ type: s.type, message: s.message }), flushWithin(config.fatalFlushTimeoutMs)]);
      },
    }),
  );

  // Opt-in (G6): after installErrorCapture, so ouo's own captures are known when Sentry sends them.
  const sentryClient = options.errors?.forwardSentryErrors;
  if (sentryClient) hooks.push(forwardSentryErrors({ client: sentryClient, reported, logger, emitException }));

  hooks.push(
    installAppStateListener({
      logger,
      ...(timeline.appLifecycle
        ? { onLifecycle: (state: string) => events.emit("app.lifecycle", { "ouo.app.state": state }, "info", Date.now(), { body: `app ${state}` }) }
        : {}),
      onBackground: () => {
        vitals.background();
        session.onBackground();
        contextPersister.persistNow();
        void guard.run("flush", flush, RESOLVED);
      },
      onForeground: () => {
        session.onForeground();
        vitals.foreground();
        // Back in the foreground: the network may be back too.
        void outbox.drain();
      },
    }),
  );

  const navigation = createNavigationTracker((attrs) => {
    // First: a never-record screen pauses capture before anything else runs for it.
    replay.setScreen(String(attrs["url.path"] ?? ""));
    events.emit("navigation", { ...attrs, "ouo.navigation.kind": "screen" });
    onActivity();
    replay.screenDidChange();
    vitals.navigated(screenName(String(attrs["url.path"] ?? "")));
  });

  // `ui.tap` at the touch start, on the screen it started on; the body is the user step as a person reads it.
  const emitTap = (target: string, path: string | undefined, gesture: Gesture, viewType: string | undefined, at: number, screen: string): void => {
    if (!timeline.taps || !target) return;
    const attrs: Attrs = { "ouo.ui.target": target, "ouo.ui.gesture": gesture };
    if (path && path !== target) attrs["ouo.ui.path"] = path;
    if (viewType) attrs["ouo.ui.view_type"] = viewType;
    if (screen) attrs["app.screen.name"] = screen;
    events.emit("ui.tap", attrs, "info", at, { body: userStep(gesture, target, viewType, screen) });
  };

  // The touch RUMProvider saw start, until its end. A touch whose end never came (its view
  // unmounted) is replaced by the next one-finger start. A nested provider gets the same event
  // object as it bubbles, and a second finger has more than one touch down: neither starts a touch.
  let touch: { event: TouchEventLike; touched: TouchedComponent | undefined; x: number; y: number; at: number; screen: string } | undefined;

  // CFG-3: never the project token (not even a prefix), nor a user id.
  logger.log(`${SDK_NAME}@${SDK_VERSION} initialised`, {
    endpoint: endpoints.endpoint,
    traces: endpoints.traces,
    logs: endpoints.logs,
    replayChunks: replay.active ? endpoints.replayChunks : null,
    replayEndpointDerived: endpoints.replayEndpointDerived,
    projectId,
    session: session.id(),
    sampling: { session: sessionSampleRate, replay: replayOptions?.sampleRate ?? 1, replayOnError: replayOptions?.onErrorSampleRate ?? 0 },
  });

  // ---- public API: every function inside the guard, a no-op after shutdown or self-disable (API-1) ----
  let closed = false;
  function api<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R | undefined;
  function api<A extends unknown[], R>(name: string, fn: (...args: A) => R, fallback: R): (...args: A) => R;
  function api<A extends unknown[], R>(name: string, fn: (...args: A) => R, fallback?: R): (...args: A) => R | undefined {
    return (...args: A) => (closed ? fallback : guard.run(`api.${name}`, () => fn(...args), fallback as R));
  }

  const recordException = api("recordException", (err: unknown, attributes?: Attrs): void => {
    reported.add(err);
    emitException(err, exceptionAttributes(err, "captured", false, { "ouo.exception.source": "manual", ...appAttributes(attributes, drops, EXCEPTION_SETTABLE) }));
  });
  const recordEvent = api("recordEvent", (name: string, attributes?: Attrs, body?: string): void => {
    if (typeof name !== "string" || name === "") return drops.count("log", "invalid");
    if (isReservedName(name)) return drops.count("log", "reserved_name");
    events.emit(name, { ...appAttributes(attributes, drops), "ouo.event.custom": true }, "info", Date.now(), typeof body === "string" ? { body } : {});
  });
  // Read inside `guard.host`: options with a throwing getter are the app's mistake, not an SDK error.
  const spanOptions = (o: SpanOptions | undefined): SpanOptions =>
    guard.host("spanOptions", () => (o && typeof o === "object" ? { ...o, attributes: appAttributes(o.attributes, drops) } : {}), {});

  // Stops everything that is not capture: timers, the retry loop, the globals the SDK registered.
  const release = (): void => {
    drops.stop();
    events.close();
    outbox.stop();
    void contextPersister.shutdown();
  };
  // Self-disable (ERR-6): what is queued is not sent; the providers are closed so no timer stays.
  onSelfDisable(() => {
    closed = true;
    guard.host("release", release);
    void Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]).catch(() => undefined);
    if (getRUM() === rum) setRUM(undefined);
  });

  /** LIF-4. `end`: the session ends with reason `shutdown`; without it (`_uninstall`) it stays open for a re-init in this process. */
  const close = async (end: boolean): Promise<void> => {
    if (closed) return;
    if (end) {
      // Synchronously: from this line every public function is a no-op and `init` works again.
      closed = true;
      if (getRUM() === rum) setRUM(undefined);
    }
    const replayFlushed = end ? guard.run("replay.flush", () => replay.flush(), RESOLVED) : RESOLVED;
    stopCapture();
    // Each step on its own: one that fails must not keep the others from running.
    if (end) guard.run("shutdown.session", () => session.shutdown());
    guard.run("shutdown.persist", () => session.stop());
    guard.run("shutdown.drops", () => drops.flush());
    const exported = guard.run("shutdown.export", () => Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown(), replayFlushed]).then(() => undefined), RESOLVED);
    // `end`: one deadline for the whole flush (`transport.shutdownDeadlineMs`). Else the shutdown
    // persisted its last batches and started sending them: wait for that send, so no request
    // outlives the instance, but bounded, so an app offline or on a hung request does not wait
    // on it. What is not sent stays in the outbox for the next launch (C11).
    if (end) await withTimeout(exported.then(() => outbox.drain()), config.shutdownDeadlineMs, undefined);
    else {
      await exported;
      await withTimeout(outbox.drain(), UNINSTALL_DRAIN_TIMEOUT_MS, undefined);
    }
    closed = true;
    guard.host("release", release);
    if (getRUM() === rum) setRUM(undefined);
  };

  const rum: RUMInternal = {
    setUser: api("setUser", (user: UserOptions | string | null): void => {
      if (user === null) {
        session.clearUser();
        return;
      }
      const id = typeof user === "string" ? user : user && typeof user === "object" ? user.id : undefined;
      if (typeof id !== "string" || id === "") return;
      session.setUser(id);
      logger.log("user set");
    }),
    setGlobalAttributes: api("setGlobalAttributes", (attributes: Attrs): void => {
      globalAttributes = appAttributes(attributes, drops);
    }),
    recordException,
    captureError: recordException,
    recordEvent,
    addEvent: (name: string, attrs?: Attrs) => recordEvent(name, attrs),
    trackNavigation: api("trackNavigation", (path: string, attrs?: Attrs): void => {
      if (typeof path !== "string") return;
      navigation.track(path, appAttributes(attrs, drops));
    }),
    recordActivity: api("recordActivity", onActivity),
    trackTap: api("trackTap", (target: string, path?: string, gesture: Gesture = "tap"): void => {
      if (typeof target !== "string") return;
      onActivity();
      emitTap(target, typeof path === "string" ? path : undefined, GESTURES.includes(gesture) ? gesture : "tap", undefined, Date.now(), screenName(navigation.current()));
    }),
    _touchStart: api("touchStart", (event: TouchEventLike, touched: TouchedComponent | undefined): void => {
      if (!event || touch?.event === event || (event.nativeEvent?.touches?.length ?? 1) > 1) return;
      const p = event.nativeEvent;
      touch = { event, touched, x: p?.pageX ?? 0, y: p?.pageY ?? 0, at: Date.now(), screen: screenName(navigation.current()) };
    }),
    _touchEnd: api("touchEnd", (event: TouchEventLike): void => {
      const t = touch;
      touch = undefined;
      if (!t?.touched) return;
      const p = event?.nativeEvent;
      const gesture = gestureOf(Date.now() - t.at, (p?.pageX ?? t.x) - t.x, (p?.pageY ?? t.y) - t.y);
      // Labels off: what was touched (its view type), not what it is called.
      if (timeline.tapLabels) emitTap(t.touched.target, t.touched.path, gesture, t.touched.viewType, t.at, t.screen);
      else emitTap(t.touched.viewType, undefined, gesture, t.touched.viewType, t.at, t.screen);
    }),
    reportFullyDisplayed: api("reportFullyDisplayed", (): void => vitals.fullyDisplayed()),
    startSpan: (name: string, options?: SpanOptions): Span => (closed ? noopSpan() : spans.startSpan(name, spanOptions(options))),
    // Not through `api`: the app's function always runs, and what it throws is the app's.
    withSpan: <T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T =>
      closed || guard.disabled ? (typeof fn === "function" ? fn(noopSpan()) : (undefined as T)) : spans.withSpan(name, fn, spanOptions(options)),
    log,
    feedback: api("feedback", (input): string | undefined => {
      const id = uuidv4();
      const record = feedbackRecord(input && typeof input === "object" ? input : undefined, id);
      if (!record) {
        logger.warn("feedback: empty message, nothing sent");
        return undefined;
      }
      // First: after an idle timeout this rotates the session, so the frame, the last events and
      // the record all belong to the session the feedback lands on.
      onActivity();
      const screenshot = input.screenshot === true && replay.isRecording();
      if (screenshot) record.attrs["ouo.feedback.screenshot"] = true;
      replay.onFeedback();
      record.attrs["ouo.last_events"] = lastEventsAttribute(recent.read(session.id()));
      events.emit("feedback", record.attrs, "info", Date.now(), { body: record.body });
      // Then a masked frame of the screen the user reports on (`navigation` mode: once it settled;
      // `session` mode: the next interval frame, drawn or not). Asked for after the record is
      // stamped, so the frame lands after it: on a still screen it is the replay's frame after the
      // feedback (C10.1), which a request made before could take in the same millisecond.
      if (screenshot) replay.screenDidChange();
      return id;
    }),
    replay: {
      pause: api("replay.pause", () => replay.pause()),
      resume: api("replay.resume", () => replay.resume()),
      isRecording: api("replay.isRecording", () => replay.isRecording(), false),
      hideScreen: api("replay.hideScreen", () => replay.hideScreen()),
      showScreen: api("replay.showScreen", () => replay.showScreen()),
      start: api("replay.start", () => {
        replay.start(session.id());
        replay.resume();
      }),
      stop: api("replay.stop", () => {
        // Held as a pause too, so a session rotation does not start the recorder again.
        replay.pause();
        replay.stop();
      }),
      capture: api("replay.capture", () => replay.forward("capture")),
      mask: api("replay.mask", (target: unknown) => replay.forward("mask", target)),
      unmask: api("replay.unmask", (target: unknown) => replay.forward("unmask", target)),
    },
    session: {
      id: api("session.id", () => session.id(), ""),
      userId: api("session.userId", () => session.userId(), ""),
      previousId: api("session.previousId", () => session.previousId()),
    },
    ready,
    flush: api("flush", flush, RESOLVED),
    getSessionId: api("getSessionId", () => session.id()),
    restartSession: api("restartSession", () => session.restart()),
    // Not through `api`: shutdown also has to work once the SDK disabled itself.
    shutdown: () => guard.host("shutdown", () => close(true).catch(() => undefined), RESOLVED),
    getTracerProvider: () => tracerProvider,
    getLoggerProvider: () => loggerProvider,
    _rootMounted: api("rootMounted", () => vitals.rootMounted()),
    _uninstall: () => close(false).catch(() => undefined),
  };
  setRUM(rum);
  return rum;
}

// ---- the spec's module-level API (3.1): each forwards to the instance `init` made, and is a
// no-op that does not throw before `init` and after `shutdown` (API-1) ----

function forward<T>(fn: (rum: RUM) => T, fallback: T): T {
  try {
    const rum = getRUM();
    return rum ? fn(rum) : fallback;
  } catch {
    return fallback;
  }
}

/** Stop capture, remove every hook, end the session and flush (bounded by `transport.shutdownDeadlineMs`). */
export const shutdown = (): Promise<void> => forward((r) => r.shutdown(), RESOLVED);
/** Export what is queued. Never rejects. */
export const flush = (): Promise<void> => forward((r) => r.flush(), RESOLVED);
/** The current session id, or undefined when the SDK is not running. */
export const getSessionId = (): string | undefined => forward((r) => r.getSessionId(), undefined);
/** End the session and start a new one. */
export const restartSession = (): void => forward((r) => r.restartSession(), undefined);
/** Set the user id, or clear it with `null`. */
export const setUser = (user: UserOptions | string | null): void => forward((r) => r.setUser(user), undefined);
/** Attributes for every later record. */
export const setGlobalAttributes = (attributes: Attrs): void => forward((r) => r.setGlobalAttributes(attributes), undefined);
/** A custom event. */
export const recordEvent = (name: string, attributes?: Attrs, body?: string): void => forward((r) => r.recordEvent(name, attributes, body), undefined);
/** A handled exception. */
export const recordException = (error: unknown, attributes?: Attrs): void => forward((r) => r.recordException(error, attributes), undefined);
/** A screen view, for routers the SDK cannot see. */
export const trackNavigation = (path: string, attributes?: Attrs): void => forward((r) => r.trackNavigation(path, attributes), undefined);
/** The SDK's tracer provider; a no-op provider when the SDK is not running. */
export const getTracerProvider = (): TracerProvider => forward((r) => r.getTracerProvider(), NOOP_TRACER_PROVIDER);
/** The SDK's logger provider; a no-op provider when the SDK is not running. */
export const getLoggerProvider = (): LoggerProviderApi => forward((r) => r.getLoggerProvider(), NOOP_LOGGER_PROVIDER);
/** Replay control. */
export const replay = {
  start: (): void => forward((r) => r.replay.start(), undefined),
  stop: (): void => forward((r) => r.replay.stop(), undefined),
  capture: (): void => forward((r) => r.replay.capture(), undefined),
  mask: (target: unknown): void => forward((r) => r.replay.mask(target), undefined),
  unmask: (target: unknown): void => forward((r) => r.replay.unmask(target), undefined),
};

/** `app.screen.name`: the route name, the last segment of a navigation path. */
function screenName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const GESTURE_WORDS: Record<Gesture, string> = { tap: "Tap", long_press: "Long press", swipe: "Swipe" };

/** `Tap add-to-cart (button) on Products`. */
function userStep(gesture: Gesture, target: string, viewType?: string, screen?: string): string {
  return `${GESTURE_WORDS[gesture]} ${target}${viewType && viewType !== target ? ` (${viewType})` : ""}${screen ? ` on ${screen}` : ""}`;
}

/**
 * How long `_uninstall` waits for the outbox to send what the shutdown exported.
 * @internal Exported for the SDK's tests; not part of the public API.
 */
export const UNINSTALL_DRAIN_TIMEOUT_MS = 2000;

/** Metro dev-server endpoints: `POST /symbolicate` (LogBox), `POST /__sentry/context` (Sentry's middleware). */
export const METRO_DEV_ENDPOINTS = /^https?:\/\/[^/]+\/(?:symbolicate|__sentry\/[^?#]*)(?:[?#]|$)/;

function isDev(): boolean {
  return (globalThis as { __DEV__?: unknown }).__DEV__ === true;
}

/** react-navigation helper: `<NavigationContainer onStateChange={navigationStateListener(rum)}>`. */
export function navigationStateListener(rum: RUM): (state: NavigationStateLike | undefined) => void {
  // Straight through to the instance tracker so `ouo.navigation.from` and de-duplication
  // use the same state as `rum.trackNavigation`.
  return (state) => {
    guard.run("navigation.state", () => rum?.trackNavigation(activeRoutePath(state)));
  };
}
