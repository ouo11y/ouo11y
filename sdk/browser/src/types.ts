/** Primitive attribute values accepted by the public API. */
export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface ServiceOptions {
  /** `service.name`, for example `web-store`. */
  name: string;
  /** `service.version`, the app version dimension used for health percentages. */
  version: string;
  /** `deployment.environment.name`, for example `local`. */
  environment: string;
}

export interface TracingOptions {
  /**
   * Origins (as RegExp or exact strings) that receive `traceparent` and `baggage`
   * headers on outbound fetch / XHR requests. Same-origin requests always get them.
   */
  propagateTo?: Array<RegExp | string>;
  /** URLs (RegExp or exact strings) never traced. The OTLP and replay endpoints are always ignored. */
  ignoreUrls?: Array<RegExp | string>;
  /**
   * Record a `documentLoad` span from Navigation Timing. Default true. A server-rendered page
   * that writes `<meta name="traceparent" content="00-<trace>-<span>-01">` makes it a child of
   * the server span that rendered the page (see the README, "Linking the page load").
   */
  documentLoad?: boolean;
  /**
   * A `click` span per click that parents the requests and the soft navigation the click causes
   * (interaction tracing). It ends one idle period after the last request or DOM change; a click
   * that caused no request is not exported. Default true.
   */
  interactions?: boolean;
  /** A `soft-navigation` span per SPA route change, ending when the new route settles. Default true. */
  softNavigations?: boolean;
  /** Quiet period that ends a click or soft-navigation span. Default 1000 ms. */
  idleTimeoutMs?: number;
}

export interface RageClickOptions {
  /** Clicks in one burst that make it a rage click. Default 3. */
  threshold?: number;
  /** Every click of a burst falls within this time from its first click. Default 1000 ms. */
  windowMs?: number;
  /** Clicks on different elements still join a burst within this distance. Default 30 px. */
  radiusPx?: number;
}

export interface ClickOptions {
  /** `ouo.rage_click` events, or false. Default on. */
  rageClicks?: RageClickOptions | false;
  /** `ouo.dead_click` events: a button or link click after which nothing happened. Default true. */
  deadClicks?: boolean;
}

export interface LongTaskOptions {
  /** Report long animation frames (long tasks where unsupported) at least this long. Default 100 ms. */
  thresholdMs?: number;
  /** At most this many events per page load. Default 50. */
  maxPerPage?: number;
}

export interface SamplingOptions {
  /**
   * Fraction of sessions that send anything (spans, events, replay), decided once per session
   * and persisted with it. Unsampled sessions propagate `traceparent` with the sampled flag off.
   * Default 1.
   */
  sessionSampleRate?: number;
}

export interface ReplayOptions {
  /** When false rrweb is never loaded. Default true. */
  enabled?: boolean;
  /** Mask every input value. Default true. */
  maskAllInputs?: boolean;
  /** Fraction of (sampled) sessions that get a replay, decided once per session and persisted. Default 1. */
  sampleRate?: number;
  /**
   * Fraction of the sessions without a replay (`sampleRate`) that keep the last 30 to 60 s of
   * replay in memory and upload it, and the rest of the session, after the first error. Decided
   * once per session. Default 0.
   */
  onErrorSampleRate?: number;
  /** Flush a chunk at least this often. Default 5000. */
  flushIntervalMs?: number;
  /** Flush a chunk when the buffered events exceed this many bytes. Default 262144 (256 KB). */
  maxChunkBytes?: number;
}

export interface SessionOptions {
  /** Default 30 minutes. */
  inactivityTimeoutMs?: number;
  /** Default 4 hours. */
  maxDurationMs?: number;
}

export interface UserOptions {
  id: string;
}

export interface RUMOptions {
  /**
   * Collector OTLP/HTTP base URL, for example `https://otel.example.com` or
   * `http://localhost:4318`. The SDK posts OTLP to `${endpoint}/v1/traces` and `/v1/logs`
   * (ADR-0007).
   */
  endpoint: string;
  /**
   * Replay receiver base URL; chunks go to `${replayEndpoint}/v1/replay/chunks`. Optional:
   * when `endpoint` uses port 4318 the default is the same scheme and host on port 4319
   * (the collector's replay receiver), otherwise `endpoint` itself (a proxy routing
   * `/v1/replay/*` to the receiver).
   */
  replayEndpoint?: string;
  /**
   * Project identifier, the HTTP Basic username. Required: `initRUM` throws when it is missing,
   * empty or contains `:`.
   */
  projectId: string;
  /**
   * Public project token, the HTTP Basic password. Every ingest request (OTLP and replay)
   * carries `Authorization: Basic base64(projectId + ":" + projectToken)`. It is not a secret
   * (browser code is readable by anyone); it only selects the project telemetry is written to.
   * Required: `initRUM` throws when it is missing or empty.
   */
  projectToken: string;
  service: ServiceOptions;
  tracing?: TracingOptions;
  replay?: ReplayOptions;
  sampling?: SamplingOptions;
  clicks?: ClickOptions;
  /** `ouo.long_animation_frame` (Chromium 123+) or `ouo.long_task` events, or false. Default on. */
  longTasks?: LongTaskOptions | false;
  session?: SessionOptions;
  user?: UserOptions;
  /** Log SDK decisions to the console with the `[ouo]` prefix. */
  debug?: boolean;
}

export interface RUMReplay {
  pause(): void;
  resume(): void;
  isRecording(): boolean;
}

export interface RUMSession {
  id(): string;
  userId(): string;
}

export interface RUM {
  setUser(user: UserOptions): void;
  /** Report a handled, non-fatal exception. */
  captureError(err: unknown, context?: Attrs): void;
  /** Emit a custom event (an OTel log record with `event.name = name`). */
  addEvent(name: string, attrs?: Attrs): void;
  /**
   * Name the current route by its template (`/products/:id`): `app.screen.name` on the open
   * soft-navigation span and on every later span and event. Router integrations call it.
   */
  setRoute(name: string): void;
  replay: RUMReplay;
  session: RUMSession;
  /** Force export of pending spans, log records and replay chunks. */
  flush(): Promise<void>;
}
