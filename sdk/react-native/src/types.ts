import type { Span, SpanContext, TracerProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import type { Gesture } from "./taps";

/** Primitive attribute values accepted by the public API. */
export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface ServiceOptions {
  /** `service.name`, for example `mobile-store`. */
  name: string;
  /** `service.version`: the app version (pass `Constants.expoConfig.version`). It is the version dimension of health percentages. */
  version: string;
  /** `deployment.environment.name`, for example `local`. */
  environment: string;
}

export interface TracingOptions {
  /**
   * URL prefixes (RegExp or exact strings) that receive `traceparent` (and `baggage` with
   * `propagation.sessionBaggage`) on outbound requests. Requests to other hosts still get a
   * client span. A request that already carries a `traceparent` is never changed.
   */
  propagateTo?: Array<RegExp | string>;
  /** URLs (RegExp or exact strings) never traced. The ingest URLs derived from `endpoint` / `replayEndpoint` are always ignored. */
  ignoreUrls?: Array<RegExp | string>;
}

export interface SamplingOptions {
  /** The spec's name for `session.sampleRate`; wins when both are set. */
  sessionRate?: number;
  bypass?: {
    /**
     * An unsampled session still sends its unhandled exceptions, crashes and hangs, marked
     * `ouo.sampling.bypass = true`: at most this many per session (crashes are not capped).
     * Default 10.
     */
    perSessionCap?: number;
  };
}

export interface PropagationOptions {
  /**
   * Also send W3C `baggage: session.id=<id>` on the requests that get `traceparent`
   * (`tracing.propagateTo`), so a backend can put the session id on its own telemetry. Default
   * false (spec PRP-6); nothing but the session id is ever sent.
   */
  sessionBaggage?: boolean;
}

export interface SessionOptions {
  /** Default 30 minutes. */
  inactivityTimeoutMs?: number;
  /** Default 4 hours. */
  maxDurationMs?: number;
  /** Background longer than this ends the session on foreground. Default 30 seconds. */
  backgroundTimeoutMs?: number;
  /**
   * Fraction of sessions whose telemetry (spans, events, logs, errors) and replay are sent,
   * 0 to 1. Default 1. The decision is a deterministic hash of the session id (the rule
   * rum-api applies for a per-project server-side cap), made once when the session starts and
   * kept with it. A session outside the sample sends only its bypass set (unhandled exceptions,
   * crashes, hangs; see `sampling.bypass`), and its requests still carry `traceparent`, with
   * the sampled flag clear.
   */
  sampleRate?: number;
}

export interface UserOptions {
  id: string;
}

/**
 * Session replay (ADR-0006): native screenshot capture through the `OuoReplay` Expo module
 * (iOS and Android). Off unless `enabled: true`. Needs a development build
 * (`npx expo prebuild && npx expo run:ios`); in Expo Go and on web it silently stays off.
 */
/**
 * `session`: a frame per `frameInterval` while the screen changes. `navigation`: one frame per
 * screen (start, resume, every route change). `auto`: `navigation` on devices with less than
 * 3.5 GiB of RAM, `session` otherwise.
 */
export type ReplayMode = "auto" | "session" | "navigation";

export interface ReplayOptions {
  /** Default false. */
  enabled?: boolean;
  /** What is captured. Default `auto`. */
  mode?: ReplayMode;
  /** Shortest time between two frames in `session` mode, in seconds. Default 1. */
  frameInterval?: number;
  /**
   * Redact labels and React Native `<Text>` (not inputs). Default true. Set to `false` when
   * replays must stay readable; inputs are governed by `maskInputs` and stay redacted.
   */
  maskText?: boolean;
  /** Redact text inputs (`TextInput`, `UITextField`, `UITextView`). Default true. */
  maskInputs?: boolean;
  /** Redact image views. Default true. */
  maskImages?: boolean;
  /** Redact WKWebView. Default true. */
  maskWebViews?: boolean;
  /**
   * Never-record screens: while the screen the SDK tracks (`navigationStateListener` or
   * `trackNavigation`) matches one of these, native capture is paused and sends no frame. A
   * string matches the screen name (the path's last segment, `IdentityCheck`) or the whole path
   * (`/Account/IdentityCheck`) exactly, or as a prefix when it ends with `*`; a RegExp is tested
   * against both. Hiding writes an `ouo.replay.hidden` event (reason `screen`) to the timeline;
   * the replay resumes with a full frame 500 ms after the screen is left. Native screens the SDK cannot
   * see as routes (Stripe Identity, a document scanner) need `rum.replay.hideScreen()`.
   */
  excludeScreens?: Array<string | RegExp>;
  /**
   * Fraction of (session-sampled) sessions recorded from their start, 0 to 1. Default 1.
   * Deterministic per session id, like `session.sampleRate`.
   */
  sampleRate?: number;
  /**
   * Fraction of the sessions left out by `sampleRate` that start recording at their first
   * error (`captureError`, unhandled errors and rejections), 0 to 1. Default 0. Recording
   * covers the rest of the session from the error on: the native recorder keeps no buffer
   * of the frames before it.
   */
  onErrorSampleRate?: number;
  /**
   * Next-launch keep/drop (client-side tail sampling). When set, a session's replay chunks stay
   * on the device and, at the next launch, this is called once per finished session with its
   * summary; the chunks are sent when it returns true and deleted otherwise. A throw keeps them.
   * Keep sessions with `feedback > 0` too: their replay is the screenshot of that feedback (C10).
   * Held chunks beyond 10 MB are deleted unsent, the oldest first. iOS only.
   */
  keepAtNextLaunch?: (session: HeldReplaySession) => boolean | Promise<boolean>;
}

/** What `replay.keepAtNextLaunch` knows about a finished session whose replay is on the device. */
export interface HeldReplaySession {
  sessionId: string;
  chunks: number;
  bytes: number;
  /** When its first and last chunk were cut (epoch ms). */
  firstChunkAt: number;
  lastChunkAt: number;
  /** The session ended with a crash (JS fatal error or native crash). */
  crashed: boolean;
  /** Exceptions reported in the session (unhandled, `console.error`, `captureError`). */
  errors: number;
  /** Feedback sent in the session (`rum.feedback`): its replay is the feedback's screenshot, keep it. */
  feedback: number;
}

/** How telemetry reaches the collector (README, "Delivery"). */
export interface TransportOptions {
  /**
   * Keep OTLP requests on the device (AsyncStorage) until the collector accepts them, so an
   * outage, a crash or a kill loses nothing: sent on the next launch, on foreground and after a
   * backoff. The oldest are dropped beyond the bounds. False sends from memory only. Default on.
   */
  offline?: OfflineOptions | false;
  /**
   * Largest OTLP request, in bytes before gzip (spec TRN-4). A batch over it is split; a record
   * that alone is over it is dropped and counted (`too_large`). Default 1 MiB.
   */
  maxRequestBytes?: number;
  /** How long `shutdown()` waits for its last flush, in milliseconds. Default 2000. */
  shutdownDeadlineMs?: number;
}

/** What `beforeSend` receives: a copy of a log record (an event, a log line, an exception) or of an ended span. */
export interface BeforeSendRecord {
  type: "log" | "span";
  /** `event.name` of a log record (`log` for a plain log line), the name of a span. */
  name: string;
  /** Body of a log record, when it is text. */
  body?: string;
  attributes: Attrs;
}

/**
 * Runs on every log record and span before it is kept or sent (spec CFG-4). Return the record
 * (changed or not) to send it, `null` or `false` to drop it; returning nothing sends the record
 * as the hook left it. A hook that throws sends the unmodified record. Replay chunks never pass
 * through it. Keep it fast: it runs on the JS thread for every record.
 */
export type BeforeSend = (record: BeforeSendRecord) => BeforeSendRecord | null | false | void;

export interface PrivacyOptions {
  /** Query keys whose values are kept in recorded URLs; every other query value becomes `REDACTED` (spec PRV-10). Default none. */
  urlQueryAllow?: string[];
  /** Keep the fragment of recorded URLs (a query-shaped fragment is sanitised like a query). Default false. */
  keepUrlFragment?: boolean;
}

export interface DiagnosticsOptions {
  /** Internal errors after which the SDK stops capture and becomes a no-op (spec ERR-6). Default 20. */
  selfDisableThreshold?: number;
}

export interface OtelOptions {
  /**
   * Also register the SDK's tracer provider, logger provider, propagator and context manager as
   * the OpenTelemetry globals (`trace.getTracer(...)`, `context.active()`). Default false: the
   * SDK works on its own instances and never replaces a global the app registered (spec REL-4).
   * Reach the providers with `getTracerProvider()` and `getLoggerProvider()` either way.
   */
  registerGlobal?: boolean;
}

export interface OfflineOptions {
  /** Default 5 MB (uncompressed JSON). At most 500 requests are kept; there is no age limit. */
  maxBytes?: number;
}

/** Device attributes the host app can supply (for example from `expo-device`). */
export interface DeviceOptions {
  /** `device.model.identifier`, for example `iPhone15,2`. */
  modelIdentifier?: string;
  /** `device.model.name`, for example `iPhone 14 Pro`. */
  modelName?: string;
  /** `device.manufacturer`, for example `Apple`. */
  manufacturer?: string;
  /** `os.name` override; defaults to `iOS` / `Android` from `Platform.OS`. */
  osName?: string;
  /** `os.version` override; defaults to `Platform.Version`. */
  osVersion?: string;
}

/** AsyncStorage-compatible persistence. Injectable for tests and for non-Expo setups. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ErrorOptions {
  /** Also report `console.error` calls as handled, non-fatal exceptions. Default true. */
  consoleErrors?: boolean;
  /** How long a fatal error waits for the crash marker and the flush before the previous handler runs. Default 2000. */
  fatalFlushTimeoutMs?: number;
  /**
   * Called with every unhandled promise rejection after ouo recorded it. Hermes keeps a single
   * rejection tracker and the SDK initialised last owns it; next to Sentry (initialised before
   * ouo) forward the rejection so Sentry still reports it:
   * `onUnhandledRejection: (e) => Sentry.captureException(e, { mechanism: { type: "onunhandledrejection", handled: true } })`.
   */
  onUnhandledRejection?: (error: unknown) => void;
  /**
   * Capture native crashes (iOS: signals and uncaught NSExceptions) with the Expo module. The
   * report is written at crash time and sent on the next launch as a fatal `exception` of the
   * crashed session, which ends with reason `crash` at the crash time. Next to Sentry, ouo calls
   * Sentry's handlers after its own, so both report the crash. Also reports what no handler sees
   * (mobile SDK spec C3): a kill in the foreground without a crash report (out of memory, the
   * watchdog) as a fatal `termination` on the next launch, and main-thread hangs of 2 s or more
   * as non-fatal `hang` exceptions. Default true; needs the native module (not in Expo Go).
   */
  nativeCrashes?: boolean;
  /**
   * Opt-in, next to Sentry (checklist G6): pass `Sentry.getClient()` and every error event
   * Sentry sends (`Sentry.captureException`, `Sentry.ErrorBoundary`, Sentry's integrations) is
   * also an ouo `exception` (`ouo.exception.kind = "sentry"`). Errors ouo captured itself (the
   * global handler, unhandled rejections, console.error of the same Error object) are not
   * reported twice; `captureMessage` and transactions are not forwarded. Events dropped by
   * Sentry's `beforeSend` or `sampleRate` are not forwarded either.
   */
  forwardSentryErrors?: SentryClientLike;
}

/** The part of a Sentry client (`Sentry.getClient()`, @sentry/core 8 to 10) the SDK uses. */
export interface SentryClientLike {
  on?(hook: "beforeSendEvent", callback: (event: SentryEventLike, hint?: SentryHintLike) => void): (() => void) | void;
}

export interface SentryEventLike {
  type?: string;
  level?: string;
  event_id?: string;
  message?: string;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { type?: string; handled?: boolean; synthetic?: boolean };
      stacktrace?: { frames?: Array<{ function?: string; filename?: string; module?: string; lineno?: number; colno?: number; in_app?: boolean }> };
    }>;
  };
}

export interface SentryHintLike {
  originalException?: unknown;
}

/** Timeline events the SDK records (checklist G4), each named like the Sentry bridge's (spec section 9a). Default all true. */
export interface TimelineOptions {
  /**
   * `ui.tap` from touches inside `<RUMProvider>`: `ouo.ui.target`, `ouo.ui.path`,
   * `ouo.ui.view_type`, `ouo.ui.gesture` (`tap`, `long_press`, `swipe`), `app.screen.name`.
   */
  taps?: boolean;
  /**
   * Content kill switch. `false`: taps the provider records carry no label (`ouo-label`,
   * `accessibilityLabel`, test id): `ouo.ui.target` is the view type and there is no
   * `ouo.ui.path`; gesture, view type and screen stay. Targets passed to `trackTap` are kept.
   */
  tapLabels?: boolean;
  /** `app.lifecycle` from `AppState`: `ouo.app.state` = `foreground`, `inactive`, `background`. */
  appLifecycle?: boolean;
  /** `http.request` for every answered request below 500, with its span's trace id and span id. */
  requests?: boolean;
}

/** Mobile vitals (docs/specs/mobile-vitals.md). */
export interface VitalsOptions {
  /** Default true. */
  enabled?: boolean;
  /** JS event-loop stall tracking (a 50 ms timer, `ouo.stall`). Default true. */
  stalls?: boolean;
}

/** Severity of `rum.log` records. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogCallOptions {
  /** Link the record to this span instead of the active one. */
  span?: Span;
}

export type LogFn = (message: string, attrs?: Attrs, options?: LogCallOptions) => void;

/**
 * `rum.log(level, message, attrs)` or `rum.log.info(message, attrs)`: an OTel log record named
 * `log` with the severity, the message as body and `message`, the attributes, the session
 * attributes and the active span's trace id.
 */
export interface RUMLog {
  (level: LogLevel, message: string, attrs?: Attrs, options?: LogCallOptions): void;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
}

export interface SpanOptions {
  attributes?: Attrs;
  /** `SpanKind` from `@opentelemetry/api`; default `INTERNAL`. */
  kind?: number;
  /** Epoch milliseconds, a `Date` or an OTel `HrTime`. */
  startTime?: number | Date | [number, number];
  /** Parent span; default the active span (inside `withSpan`), `null` for a new trace. */
  parent?: Span | SpanContext | null;
}

export interface RUMOptions {
  /**
   * Collector OTLP/HTTP base URL, for example `https://otel.example.com` or
   * `http://localhost:4318` (ADR-0007). The SDK posts traces to `${endpoint}/v1/traces` and
   * events to `${endpoint}/v1/logs`. Requests to the ingest URLs are never traced.
   */
  endpoint: string;
  /**
   * Base URL of the collector's replay receiver; chunks go to `${replayEndpoint}/v1/replay/chunks`.
   * Optional: defaults to `endpoint` with port 4318 replaced by 4319 (the collector's default
   * replay port), or to `endpoint` itself when it uses any other port (a proxy such as
   * `https://otel.example.com` routes `/v1/replay/*` to the receiver itself).
   */
  replayEndpoint?: string;
  /**
   * Project id, the user name of the HTTP Basic credential (`Authorization: Basic
   * base64("<projectId>:<projectToken>")`) sent on every OTLP export and replay upload.
   * Required: without it the SDK is a no-op (a diagnostic says so when `debug` is on).
   */
  projectId: string;
  /**
   * Project token, the password of the Basic credential. Public by nature (it only grants the
   * right to write telemetry into one project); required, the SDK is a no-op without it. It is
   * never written to a diagnostic, a URL or a record.
   */
  projectToken: string;
  service: ServiceOptions;
  tracing?: TracingOptions;
  propagation?: PropagationOptions;
  sampling?: SamplingOptions;
  replay?: ReplayOptions;
  session?: SessionOptions;
  user?: UserOptions;
  device?: DeviceOptions;
  /**
   * Extra resource attributes on every span and log record, for example the rollout cohort
   * `{ "ouo.rum.mode": "parallel" }`. Prefix your own keys with `ouo.`. The SDK's attributes
   * (`service.*`, `ouo.platform`, `ouo.sdk.*`, `os.*`, `device.*`) win on a clash.
   */
  resource?: Attrs;
  errors?: ErrorOptions;
  timeline?: TimelineOptions;
  vitals?: VitalsOptions;
  transport?: TransportOptions;
  /** Persistence; defaults to `@react-native-async-storage/async-storage`. */
  storage?: AsyncKeyValueStorage;
  /** Change or drop records before they are kept or sent. */
  beforeSend?: BeforeSend;
  privacy?: PrivacyOptions;
  /**
   * Runs on every URL the SDK records (`url.full`, URLs in stack traces) after its own
   * sanitising: credentials and query values are already `REDACTED` and the fragment is gone.
   * Return the URL to record. A hook that throws leaves the sanitised URL.
   */
  sanitizeUrl?: (url: string) => string;
  diagnostics?: DiagnosticsOptions;
  otel?: OtelOptions;
  /** Log SDK decisions to the console with the `[ouo]` prefix. Diagnostics never contain record payloads or the project token. */
  debug?: boolean;
}

/** Mirrors the browser SDK's `rum.replay`. No-ops when replay is disabled or the native module is absent. */
export interface RUMReplay {
  pause(): void;
  resume(): void;
  isRecording(): boolean;
  /**
   * Never record what shows from now until `showScreen()`: native capture pauses on the next
   * main-thread turn and an `ouo.replay.hidden` event (reason `manual`) marks the gap. Call it
   * before navigating to a screen that must never appear, and before presenting a screen the SDK does not see as a route, such as a third-party SDK's
   * own view controller or activity (Stripe Identity), and `showScreen()` once it is dismissed.
   * Independent of `pause()` and `excludeScreens`: capture resumes when none of them holds it.
   */
  hideScreen(): void;
  showScreen(): void;
  /** Start recording the current session again after `stop()` (spec API: `replay.start`). The replay sample still decides whether the session is recorded. */
  start(): void;
  /** Stop recording until `start()`. */
  stop(): void;
  /** Send the buffered replay now. Forwarded to the native recorder when it supports it; a no-op until then. */
  capture(): void;
  /** Mask a view (a ref or a native tag). Forwarded to the native recorder when it supports it; a no-op until then. */
  mask(target: unknown): void;
  /** Undo `mask` for a view. Forwarded to the native recorder when it supports it; a no-op until then. */
  unmask(target: unknown): void;
}

/** `rum.feedback(...)` (docs/specs/mobile-sdk.md C10): what the user wrote, as the app passes it. */
export interface FeedbackInput {
  /** The user's text. Required: an empty message sends nothing. Cut at 4096 bytes (UTF-8) with "…". */
  message: string;
  /** How to reach the user (an email, a name), as the user typed it. Cut like the message. */
  contact?: string;
  /**
   * Ask the replay recorder for a masked frame of the current screen. Ignored when replay is not
   * recording; the record's `ouo.feedback.screenshot` says whether it was.
   */
  screenshot?: boolean;
}

export interface RUMSession {
  id(): string;
  /** The id given to `setUser`, "" when there is none. */
  userId(): string;
  /** Set on the first signals of a session that replaced an ended one. */
  previousId(): string | undefined;
}

/**
 * Every function is safe to call at any time (spec API-1): before the session is ready, after
 * `shutdown()`, without the native module, with any argument. It is then a no-op that does not
 * throw. Attribute keys starting with `session.` or `ouo.` are reserved (API-3): they are
 * dropped and counted, except `ouo.exception.fingerprint`.
 */
export interface RUM {
  /**
   * Set the user id (`setUser("u-1")` or `setUser({ id: "u-1" })`), or clear it with `null`.
   * Records carry `user.id` only after this (spec PRV-13): the SDK makes up no anonymous id.
   * The id is kept across launches until it is cleared.
   */
  setUser(user: UserOptions | string | null): void;
  /** Attributes for every later record (spans and log records). Replaces the previous set; `{}` clears it. */
  setGlobalAttributes(attributes: Attrs): void;
  /**
   * Report a handled exception: `ouo.exception.source = "manual"`, `ouo.exception.handled = true`
   * unless the attributes set it. The attributes may carry `ouo.exception.fingerprint`.
   */
  recordException(error: unknown, attributes?: Attrs): void;
  /** Alias of `recordException`. */
  captureError(err: unknown, context?: Attrs): void;
  /** Emit a custom event (an OTel log record with `event.name = name`); `body` defaults to the name. Names starting with `session.` or `ouo.` are dropped. */
  recordEvent(name: string, attributes?: Attrs, body?: string): void;
  /** Alias of `recordEvent` without a body. */
  addEvent(name: string, attrs?: Attrs): void;
  /** Emit a `navigation` event and count it as activity. */
  trackNavigation(path: string, attrs?: Attrs): void;
  /** Count a user interaction as session activity (the `RUMProvider` does this for touches). */
  recordActivity(): void;
  /**
   * Emit a `ui.tap` on the current screen (and count it as activity). `RUMProvider` records
   * touches itself; call this for gestures it cannot see. `path` is the component path,
   * innermost first, joined with ` > `; `gesture` defaults to `tap`.
   */
  trackTap(target: string, path?: string, gesture?: Gesture): void;
  /**
   * The current screen is fully displayed: its content (data, images) is on screen, not only the
   * first frame. Gives `ouo.screen.ttfd_ms` (time to full display) on the screen's
   * `ouo.screen.display` record, measured to the next frame. Call once per screen visit, for
   * example when its data loaded; without a call within 30 s the record carries TTID only.
   */
  reportFullyDisplayed(): void;
  /**
   * Start a span on the SDK's tracer (session attributes added). End it with `span.end()`.
   * Parent: `options.parent`, else the span active inside `withSpan`.
   */
  startSpan(name: string, options?: SpanOptions): Span;
  /**
   * Run `fn` inside a new span and end it when `fn` returns or its promise settles. A throw or
   * rejection sets the span status to error, is reported as an `exception` log record with the
   * span's trace id and span id (no span event, spec REL-7) and is rethrown.
   * The span is active while `fn` runs synchronously: requests started, logs and errors reported
   * there join its trace. After an `await`, pass the span on with `startSpan(name, { parent })`.
   */
  withSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T;
  /** Log API: `rum.log.info("checkout started", { "cart.items": 3 })`. */
  log: RUMLog;
  /**
   * Send the user's feedback as a `feedback` event on the current session (C10). The events before
   * it are on the session's timeline; with `screenshot: true` and replay recording, the replay at
   * that time shows the masked screen. Like every record, it follows session sampling (C1).
   * Returns the feedback id (`ouo.feedback.id`), or undefined when the message is empty.
   */
  feedback(input: FeedbackInput): string | undefined;
  replay: RUMReplay;
  session: RUMSession;
  /** Resolves once the persisted session state was read and `session.start` was emitted. */
  ready: Promise<void>;
  /** Force export of pending spans, log records and replay chunks. Never rejects. */
  flush(): Promise<void>;
  /** The current session id, or undefined when the SDK is not running. */
  getSessionId(): string | undefined;
  /** End the session (`ouo.session.end_reason = "manual"`) and start a new one linked to it. */
  restartSession(): void;
  /**
   * Stop the SDK (spec LIF-4): capture stops, every hook is removed, the session ends
   * (`ouo.session.end_reason = "shutdown"`) and what is queued is flushed, for at most
   * `transport.shutdownDeadlineMs`. `init` can be called again afterwards.
   */
  shutdown(): Promise<void>;
  /** The SDK's OpenTelemetry tracer provider: spans from its tracers carry the session attributes (spec REL-5). */
  getTracerProvider(): TracerProvider;
  /** The SDK's OpenTelemetry logger provider: records from its loggers carry the session attributes. */
  getLoggerProvider(): LoggerProvider;
}
