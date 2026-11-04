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
import { installCommitProbe } from "./commits";
import { crashMarker, createNativeCrashCapture, isReactNativeFatal, nativeCrashAttributes } from "./crash";
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
import { createTapFrustration } from "./frustration";
import { ReportedErrors } from "./errors/dedupe";
import { installErrorCapture } from "./errors/install";
import { forwardSentryErrors } from "./errors/sentry";
import { getRUM, setRUM } from "./instance";
import { createLogger } from "./logger";
import { activeRoutePath, createNavigationTracker, type NavigationStateLike } from "./navigation";
import { gestureOf, type Gesture, type TouchEventLike, type TouchedComponent } from "./taps";
import { basicAuthorization, ingestHeaders, requireCredentials, resolveEndpoints } from "./endpoints";
import { installFetchInstrumentation, installXhrInstrumentation } from "./network";
import { createReplayController, loadNativeReplayModule } from "./replay";
import { SampledLogProcessor, SampledSpanProcessor, sampleRate } from "./sampling";
import { uuidv4 } from "./session/ids";
import { SessionManager } from "./session/manager";
import { MemoryAsyncStorage, safeStorage, withTimeout } from "./session/storage";
import { StackContextManager } from "./telemetry/context";
import { SessionLogProcessor, SessionSpanProcessor } from "./telemetry/correlation";
import { EventEmitter } from "./telemetry/events";
import { SessionPropagator } from "./telemetry/propagator";
import { lastEventsAttribute, RecentEvents } from "./telemetry/recent";
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
  /** RUMProvider: a touch started on `touched` (its screen and time are read now). */
  _touchStart(event: TouchEventLike, touched: TouchedComponent | undefined): void;
  /** RUMProvider: the touch ended or was cancelled: `ui.tap` with its gesture. */
  _touchEnd(event: TouchEventLike): void;
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
  // Before the first render: Fabric's renderer reads the commit function when it loads (commits.ts).
  const commits = options.timeline?.deadTaps === false ? { count: () => 0, live: () => false, uninstall: () => {} } : installCommitProbe();
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
    // The gap in the replay, on the session's timeline (the frame chunks have no event channel).
    onHidden: (reason) => events.emit("ouo.replay.hidden", { "ouo.replay.hidden_reason": reason }),
    logger,
  });

  // ---- native crashes (signals, uncaught NSExceptions) and foreground terminations: the previous
  // run's report, taken once; main-thread hangs arrive as events once they are over (C3) ----
  const nativeCrash = createNativeCrashCapture({
    enabled: options.errors?.nativeCrashes !== false,
    logger,
    onHang: (report) => emitException(undefined, nativeCrashAttributes(report), report.timestamp_ms),
  });
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
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new SessionLogProcessor(session, serviceVersion),
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
  const timeline = {
    taps: options.timeline?.taps !== false,
    tapLabels: options.timeline?.tapLabels !== false,
    appLifecycle: options.timeline?.appLifecycle !== false,
    requests: options.timeline?.requests !== false,
  };
  const rageTaps = options.timeline?.rageTaps === false ? false : { threshold: 3, windowMs: 1000, radiusPt: 30, ...options.timeline?.rageTaps };
  const deadTapsOption = options.timeline?.deadTaps;
  const deadTaps = deadTapsOption === false ? false : { timeoutMs: 1000, ...(typeof deadTapsOption === "object" ? deadTapsOption : {}) };
  const frustration = createTapFrustration({ events, rage: rageTaps, dead: deadTaps, commits });

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
  const ready = session.start().then(async () => {
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
      // The crashed run's context, as it persisted it (no memory or network: not measured now).
      const ctx = await previousContext;
      if (ctx && ctx.sessionId === (crashed.session_id || ctx.sessionId)) Object.assign(attrs, screenContextAttributes(ctx));
      if (locale) attrs["ouo.device.locale"] = locale;
      const ended = session.peekLastEnded();
      if (ended && ended.id === crashed.session_id && ended.serviceVersion !== undefined) attrs["service.version"] = ended.serviceVersion;
      events.emit("exception", attrs, "error", crashed.timestamp_ms);
      logger.warn(`native ${crashed.mechanism} of the previous run reported`, crashed.session_id, attrs["exception.message"]);
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
    // A request answers a tap (dead taps).
    onActivity: () => {
      onActivity();
      frustration.responded();
    },
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
      frustration.responded();
      vitals.background();
      session.onBackground();
      contextPersister.persistNow();
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
    // First: a never-record screen pauses capture before anything else runs for it.
    replay.setScreen(String(attrs["url.path"] ?? ""));
    events.emit("navigation", { ...attrs, "ouo.navigation.kind": "screen" });
    frustration.responded();
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
      emitTap(target, path, gesture, undefined, Date.now(), screenName(navigation.current()));
    },
    _touchStart(event, touched): void {
      if (touch?.event === event || (event.nativeEvent?.touches?.length ?? 1) > 1) return;
      const p = event.nativeEvent;
      touch = { event, touched, x: p?.pageX ?? 0, y: p?.pageY ?? 0, at: Date.now(), screen: screenName(navigation.current()) };
    },
    _touchEnd(event): void {
      const t = touch;
      touch = undefined;
      if (!t?.touched) return;
      const p = event.nativeEvent;
      const gesture = gestureOf(Date.now() - t.at, (p?.pageX ?? t.x) - t.x, (p?.pageY ?? t.y) - t.y);
      // Labels off: what was touched (its view type), not what it is called.
      const target = timeline.tapLabels ? t.touched.target : t.touched.viewType;
      if (timeline.tapLabels) emitTap(t.touched.target, t.touched.path, gesture, t.touched.viewType, t.at, t.screen);
      else emitTap(t.touched.viewType, undefined, gesture, t.touched.viewType, t.at, t.screen);
      frustration.onTap({ target, viewType: t.touched.viewType, gesture, screen: t.screen, at: t.at, x: t.x, y: t.y, optedOut: t.touched.optedOut === true });
    },
    reportFullyDisplayed(): void {
      vitals.fullyDisplayed();
    },
    startSpan: spans.startSpan,
    withSpan: spans.withSpan,
    log,
    feedback(input): string | undefined {
      const id = uuidv4();
      const record = feedbackRecord(input, id);
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
    },
    replay: {
      pause: () => replay.pause(),
      resume: () => replay.resume(),
      isRecording: () => replay.isRecording(),
      hideScreen: () => replay.hideScreen(),
      showScreen: () => replay.showScreen(),
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
      frustration.dispose();
      commits.uninstall();
      vitals.stop();
      nativeCrash.stop();
      uninstallFetch();
      uninstallXhr();
      uninstallErrors();
      uninstallSentry();
      uninstallAppState();
      replay.stop();
      session.stop();
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
      // The shutdown persisted its last batches and started sending them: wait for that send, so
      // no request outlives the instance, but bounded, so an app offline or on a hung request
      // does not wait on it. What is not sent stays in the outbox for the next launch (C11).
      await withTimeout(outbox.drain(), UNINSTALL_DRAIN_TIMEOUT_MS, undefined);
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
  return (state) => rum.trackNavigation(activeRoutePath(state));
}
