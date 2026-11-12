import type { AttrValue, Attrs } from "./core/limits";

export type { AttrValue, Attrs };

/** A URL matcher: an exact string, a prefix ending in `*`, or a RegExp. */
export type UrlPattern = string | RegExp;

/** What a `beforeSend` hook sees and may change (CFG-4). Replay chunks never reach the hook. */
export interface OutgoingRecord {
  /** `event` for a log record with an event name, `log` for a plain log record, `span` for a span. */
  type: "event" | "log" | "span";
  /** Event name or span name. Read-only: changing it has no effect. */
  name: string;
  /** Mutable copy of the record's attributes. */
  attributes: Record<string, unknown>;
  /** Log body, when there is one. */
  body?: unknown;
}

export type BeforeSend = (record: OutgoingRecord) => OutgoingRecord | null | undefined | false | void;

export type ReplayMode = "off" | "session" | "buffer";
/**
 * What replay records. `structure`: a description of the DOM, driven by a MutationObserver, with
 * text replaced by `***` (format `rrweb/2`). `pixel`: masked images of the viewport, taken when the
 * DOM changes (format `ouo.frames/1`).
 */
export type ReplayFormat = "structure" | "pixel";

export interface Consent {
  telemetry?: boolean;
  replay?: boolean;
}

/** `init` configuration (SDK spec section 3.2). Every key but `endpoint` and `serviceName` is optional. */
export interface OuoConfig {
  /** Collector OTLP/HTTP base URL, or a same-origin path such as `/otel`. */
  endpoint: string;
  /** Sent on every export request. Values may be public ingest keys; they are never logged or put in a URL. */
  headers?: Record<string, string>;
  /** Shorthand for `headers.Authorization = "Basic base64(projectId:projectToken)"`. */
  projectId?: string;
  projectToken?: string;
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** `false` makes `init` a no-op that touches nothing. Default true. */
  enabled?: boolean;

  session?: {
    /** Default 30 min, at least 1 min. */
    inactivityTimeoutMs?: number;
    /** Default 4 h, at most 24 h. */
    maxDurationMs?: number;
  };
  sampling?: {
    /** Fraction of sessions that send telemetry. Default 1. */
    sessionRate?: number;
    bypass?: {
      /** Unhandled errors sent from a session that is not sampled, per session. Default 10. */
      perSessionCap?: number;
    };
  };
  replay?: {
    /** Default `off`. */
    mode?: ReplayMode;
    /** Fraction of sampled sessions recorded in `session` mode. Default 0. */
    sessionRate?: number;
    /** Fraction of sampled sessions that keep a ring in `buffer` mode. Default 0. */
    bufferRate?: number;
    /** Default `structure`. */
    format?: ReplayFormat;
    /** Seconds the buffer ring holds at least. Default 60. */
    bufferSeconds?: number;
    /** Default 256 KiB (compressed), hard limit 1 MiB. */
    chunkMaxBytes?: number;
    /** Default 5000. */
    chunkMaxMs?: number;
    /** Default 300 000. */
    keyframeIntervalMs?: number;
    /** Pixel format only: most frames per second. Default 1, at most 4. */
    pixelMaxFps?: number;
    /** Pixel format only: longest side of a frame in pixels. Default 1000. */
    pixelMaxSide?: number;
  };
  consent?: {
    /** Start with consent pending: nothing is sent or stored until `setConsent`. Default false. */
    required?: boolean;
  };
  privacy?: {
    /** Query keys whose values are kept in URLs. Default none. */
    urlQueryAllow?: string[];
    /** Keep the URL fragment (sanitised when query-shaped). Default false. */
    keepUrlFragment?: boolean;
  };
  /** Runs after the built-in URL sanitising. */
  sanitizeUrl?: (url: string) => string;
  /** Last look at every log record and span before it is queued, stored or sent. */
  beforeSend?: BeforeSend;
  propagation?: {
    /** Cross-origin URLs that get `traceparent`. Same-origin requests always do. Default none. */
    urls?: UrlPattern[];
    /** Send `baggage: session.id=<id>` with `traceparent`. Default false. */
    sessionBaggage?: boolean;
  };
  transport?: {
    flushIntervalMs?: number;
    maxBatchRecords?: number;
    maxRequestBytes?: number;
    maxQueueRecords?: number;
    shutdownDeadlineMs?: number;
    retry?: { initialMs?: number; maxMs?: number };
    persist?: { ttlHours?: number; maxBytes?: number; enabled?: boolean };
    /** Request timeout. Default 30 000. */
    timeoutMs?: number;
  };
  /** Diagnostics on the console. Default false. */
  debug?: boolean;
  diagnostics?: {
    /** Internal errors after which the SDK turns itself off. Default 20. */
    selfDisableThreshold?: number;
  };
  /** Per-signal switches. All on unless noted. */
  instrumentations?: {
    errors?: boolean;
    webVitals?: boolean;
    /** Full INP attribution object in the event body. Default false. */
    vitalAttributionBody?: boolean;
    clicks?: boolean;
    frustration?: boolean;
    navigation?: boolean;
    /** Report hash-only URL changes as soft navigations. Default false. */
    hashNavigation?: boolean;
    documentLoad?: boolean;
    navigationTiming?: boolean;
    /** One event per loaded resource. Default false. */
    resourceTiming?: boolean;
    fetch?: boolean;
    xhr?: boolean;
  };
  otel?: {
    /** Register the SDK's tracer and logger providers as the OpenTelemetry globals. Default false. */
    registerGlobalProviders?: boolean;
    /** URLs whose requests are not traced, besides the SDK's own exports. */
    ignoreUrls?: UrlPattern[];
  };
}

export interface NavigationOptions {
  /** URL of the view; default the page's current URL. */
  url?: string;
  /** View id to use instead of a new random one. */
  id?: string;
}
