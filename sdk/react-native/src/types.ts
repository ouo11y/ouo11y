import type { Span, SpanContext } from "@opentelemetry/api";

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
   * URL prefixes (RegExp or exact strings) that receive `traceparent` and `baggage`
   * headers on outbound fetch requests. Requests to other hosts still get a client span.
   */
  propagateTo?: Array<RegExp | string>;
  /** URLs (RegExp or exact strings) never traced. The ingest URLs derived from `endpoint` / `replayEndpoint` are always ignored. */
  ignoreUrls?: Array<RegExp | string>;
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
   * rum-api applies for a per-project server-side cap), so it holds for the whole session
   * and a session never sends part of its signals.
   */
  sampleRate?: number;
}

export interface UserOptions {
  id: string;
}

/**
 * Session replay (ADR-0006): native screenshot capture through the `OuoReplay` Expo module
 * (iOS; Android is a no-op stub). Off unless `enabled: true`. Needs a development build
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
   * Chunks held longer than 24 hours are deleted unsent. iOS only.
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
}

/** How telemetry reaches the collector (README, "Delivery"). */
export interface TransportOptions {
  /**
   * Keep OTLP requests on the device (AsyncStorage) until the collector accepts them, so an
   * outage, a crash or a kill loses nothing: sent on the next launch, on foreground and after a
   * backoff. The oldest are dropped beyond the bounds. False sends from memory only. Default on.
   */
  offline?: OfflineOptions | false;
}

export interface OfflineOptions {
  /** Default 5 MB (uncompressed JSON). At most 500 requests are kept, for at most 24 hours. */
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
   * Sentry's handlers after its own, so both report the crash. Default true; needs the native
   * module (not in Expo Go).
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
  /** `ui.tap` from touches inside `<RUMProvider>`: `ouo.ui.target`, `ouo.ui.path`. */
  taps?: boolean;
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
   * Required; `initRUM` throws without it.
   */
  projectId: string;
  /**
   * Project token, the password of the Basic credential. Public by nature (it only grants the
   * right to write telemetry into one project); required, `initRUM` throws without it.
   */
  projectToken: string;
  service: ServiceOptions;
  tracing?: TracingOptions;
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
  /** Log SDK decisions to the console with the `[ouo]` prefix. */
  debug?: boolean;
}

/** Mirrors the browser SDK's `rum.replay`. No-ops when replay is disabled or the native module is absent. */
export interface RUMReplay {
  pause(): void;
  resume(): void;
  isRecording(): boolean;
}

export interface RUMSession {
  id(): string;
  userId(): string;
  /** Set on the first signals of a session that replaced an ended one. */
  previousId(): string | undefined;
}

export interface RUM {
  setUser(user: UserOptions): void;
  /** Report a handled, non-fatal exception. */
  captureError(err: unknown, context?: Attrs): void;
  /** Emit a custom event (an OTel log record with `event.name = name`). */
  addEvent(name: string, attrs?: Attrs): void;
  /** Emit a `navigation` event and count it as activity. */
  trackNavigation(path: string, attrs?: Attrs): void;
  /** Count a user interaction as session activity (the `RUMProvider` does this for touches). */
  recordActivity(): void;
  /**
   * Emit a `ui.tap` (and count it as activity). `RUMProvider` calls this for every touch with
   * the touched component's label; call it yourself for gestures it cannot see.
   * `path` is the component path, innermost first, joined with ` > `.
   */
  trackTap(target: string, path?: string): void;
  /**
   * Start a span on the SDK's tracer (session attributes added). End it with `span.end()`.
   * Parent: `options.parent`, else the span active inside `withSpan`.
   */
  startSpan(name: string, options?: SpanOptions): Span;
  /**
   * Run `fn` inside a new span and end it when `fn` returns or its promise settles. A throw or
   * rejection sets the span status to error, records the exception on the span and rethrows.
   * The span is active while `fn` runs synchronously: requests started, logs and errors reported
   * there join its trace. After an `await`, pass the span on with `startSpan(name, { parent })`.
   */
  withSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T;
  /** Log API: `rum.log.info("checkout started", { "cart.items": 3 })`. */
  log: RUMLog;
  replay: RUMReplay;
  session: RUMSession;
  /** Resolves once the persisted session state was read and `session.start` was emitted. */
  ready: Promise<void>;
  /** Force export of pending spans, log records and replay chunks. */
  flush(): Promise<void>;
}
