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



export interface ReplayOptions {
  /** When false rrweb is never loaded. Default true. */
  enabled?: boolean;
  /**
   * Mask the value of every form control (text-like inputs, radios, checkboxes, hidden inputs,
   * `<select>` / `<option>`, `<button>`) and leave out radio / checkbox / option state, everywhere,
   * `ouo-unmask` included. Default true.
   */
  maskAllInputs?: boolean;
  /** Fraction of (sampled) sessions that get a replay: `sampled(id, rate, "replay")`, persisted. Default 1. */
  sampleRate?: number;
  /**
   * Fraction of the sessions without a replay (`sampleRate`) that keep the last 30 to 60 s of
   * replay in memory and upload it, and the rest of the session, after the first error. Decided
   * with `sampled(id, rate, "replay_on_error")` and persisted. Default 0.
   */
  onErrorSampleRate?: number;
  /** Flush a chunk at least this often. Default 5000. */
  flushIntervalMs?: number;
  /** Flush a chunk when the buffered events exceed this many bytes. Default 262144 (256 KB). */
  maxChunkBytes?: number;
  /**
   * CSS selector of elements recorded as an empty box of the same size, in addition to the
   * `ouo-block` class: privacy, and the cheapest way to keep a huge widget (a grid, a map, a
   * chart) out of the replay's snapshot and mutation cost.
   */
  blockSelector?: string;
  /**
   * CSS selector of elements whose text is masked, in addition to the `ouo-mask` class. It masks
   * inside `ouo-unmask` too.
   */
  maskTextSelector?: string;
  /**
   * Mask every text node of the replay (each non-space character becomes `*`), and the
   * attributes `title`, `alt`, `placeholder`, `aria-label`, `aria-description`,
   * `aria-valuetext`, `label` and `value` (of elements that are not form controls, whose values
   * follow `maskAllInputs`), except inside an element with
   * the class `ouo-unmask` or matching `unmaskTextSelector`. `ouo-mask` and `maskTextSelector`
   * still mask inside an unmasked area; `ouo-block` wins over both. Click names
   * (`app.widget.name`) follow the same rule: outside the allow-list a click is named by its
   * `data-testid` only. Default true (since 0.4.0; ADR-0003 revision 2026-11-03).
   */
  maskAllText?: boolean;
  /** CSS selector of elements whose text is recorded with `maskAllText`, in addition to the `ouo-unmask` class. */
  unmaskTextSelector?: string;
  /**
   * Never-record routes: while `location.pathname` matches one of these, the replay records
   * nothing (route templates from `setRoute` arrive after the page rendered and are not matched). A string matches exactly, or as a prefix
   * when it ends with `*` (`/patients/*`, like funnel `page:` steps); a RegExp is tested. Entering
   * such a route writes an `ouo.replay.hidden` marker (reason `route`) into the replay and the
   * timeline; leaving it records again from a full snapshot, 500 ms later (routers change the
   * URL before they render the next page).
   */
  excludeRoutes?: Array<string | RegExp>;
}

export interface SessionOptions {
  /** Default 30 minutes. */
  inactivityTimeoutMs?: number;
  /** Default 4 hours. */
  maxDurationMs?: number;
  /**
   * Fraction of sessions that send anything (spans, events, replay). Decided from the session id
   * with the rule shared with the React Native SDK and rum-api (`sampled(id, rate, "session")`) and
   * persisted. Unsampled sessions propagate `traceparent` with the sampled flag off. Default 1.
   */
  sampleRate?: number;
}

export interface OfflineOptions {
  /** Hard cap on the bytes kept; the oldest requests are evicted (and counted as dropped) beyond it. Default 5 MB. */
  maxBytes?: number;
  /** Requests kept longer than this are dropped unsent. Default 24 hours. */
  maxAgeMs?: number;
}

/** How telemetry reaches the collector (README, "Delivery"). */
export interface TransportOptions {
  /** gzip request bodies of 1 KB or more with `CompressionStream` where the browser has it. Default true. */
  compression?: boolean;
  /**
   * Attempts per request, the first included, on network errors, 408, 429 and 5xx (exponential
   * backoff with jitter, `Retry-After` honoured) before the request goes to the offline store.
   * Other 4xx answers are never retried. Default 5.
   */
  maxAttempts?: number;
  /**
   * Keep requests that could not be sent (offline, retries spent, page closed over the keepalive
   * budget) in IndexedDB, or memory where storage is unavailable, and send them when the browser is
   * back online or on the next page load of the origin. False drops them. Default on.
   */
  offline?: OfflineOptions | false;
  /**
   * At page hide, fall back to `navigator.sendBeacon` when the 64 KB keepalive budget is spent. A
   * beacon cannot carry `Authorization`: enable it only when `endpoint` is a first-party proxy
   * route that adds the header. Default false.
   */
  beacon?: boolean;
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
  clicks?: ClickOptions;
  /** `ouo.long_animation_frame` (Chromium 123+) or `ouo.long_task` events, or false. Default on. */
  longTasks?: LongTaskOptions | false;
  session?: SessionOptions;
  user?: UserOptions;
  transport?: TransportOptions;
  /** Log SDK decisions to the console with the `[ouo]` prefix. */
  debug?: boolean;
  /**
   * Consent at start (README, "Consent"). `"granted"`, the default, starts at once with replay
   * allowed. `"pending"` stores nothing (no `localStorage`, IndexedDB or cookie), opens no
   * BroadcastChannel, sends nothing, installs no instrumentation and creates no session until
   * `setConsent({ telemetry: true, ... })`; calls to `setUser`, `clearUser`, `captureError`,
   * `addEvent` and `setRoute` meanwhile wait in memory (at most {@link CONSENT_QUEUE_LIMIT},
   * oldest dropped first) and run at the grant. The SDK never stores the consent itself: pass
   * what the app's consent manager decided on every page load.
   */
  consent?: "pending" | "granted";
}

/** What the user agreed to. `replay` without `telemetry` means nothing. */
export interface Consent {
  /** Sessions, spans, events and errors. */
  telemetry: boolean;
  /** Session replay (rrweb), on top of `telemetry`. */
  replay: boolean;
}

export interface ConsentState extends Consent {
  /** `pending`: not decided yet. `granted`: `telemetry` is on. `denied`: revoked or refused. */
  status: "pending" | "granted" | "denied";
}

export interface RUMReplay {
  pause(): void;
  resume(): void;
  isRecording(): boolean;
}

export interface RUMSession {
  id(): string;
  userId(): string;
  /** This browser's `device.id`: random, persisted apart from the user and the session. */
  deviceId(): string;
}

export interface RUM {
  /**
   * Identify the user. Anonymous to identified (a login) keeps the session; one identified user
   * to another ends it (`user_change`) and starts a new one.
   */
  setUser(user: UserOptions): void;
  /** Logout: back to a fresh anonymous user id, in a new session (`user_change`). */
  clearUser(): void;
  /** End the session now (`manual`); the next activity starts a new one. */
  endSession(): void;
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
  /** Force export of pending spans, log records and replay chunks. Never rejects. */
  flush(): Promise<void>;
  /**
   * Flushes, then removes every hook, listener, observer and timer the SDK installed and
   * restores patched globals. `initRUM` can be called again afterwards. Never rejects.
   */
  shutdown(): Promise<void>;
  /**
   * Apply the user's choice (README, "Consent"). Granting `telemetry` starts a session and runs
   * the calls queued while pending. `replay` starts or stops the recorder on its own. Revoking
   * `telemetry` stops recording and export at once (what is still buffered is dropped, not
   * sent), removes the SDK's ids from `localStorage`, deletes the IndexedDB outbox and closes
   * its channels; a later grant starts a new device id and session. Resolves once applied.
   * Never rejects.
   */
  setConsent(consent: Consent): Promise<void>;
  /** The consent the SDK runs under now. */
  getConsent(): ConsentState;
  /** Counters of the delivery layer since `initRUM`: sent, retried, kept offline, dropped (and why), bytes before and after gzip. */
  deliveryStats(): DeliveryStats;
}

export interface DeliveryStats {
  sent: number;
  retried: number;
  queued: number;
  dropped: number;
  droppedBytes: number;
  /** `rejected`: a 4xx other than 408 and 429. `store_full`: evicted from the offline store. `too_large`: larger than the store. `expired`: stored too long. `no_store`: failed with `offline: false`. `queue_full`: the export queue overflowed. */
  dropReasons: Partial<Record<"rejected" | "store_full" | "too_large" | "expired" | "no_store" | "queue_full", number>>;
  rawBytes: number;
  wireBytes: number;
}
