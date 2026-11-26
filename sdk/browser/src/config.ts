/**
 * Configuration (CFG-1, CFG-2): nothing here throws. A missing or unusable `endpoint` or
 * `serviceName` makes the SDK a no-op; every other bad value falls back to its default and
 * out-of-range numbers are clamped, each with one diagnostic that names the key and never a value.
 */
import type { BeforeSend, UrlPattern } from "./types";

const MIN = 60_000;
const HOUR = 3_600_000;
export const CHUNK_HARD_LIMIT = 1024 * 1024;

export interface Config {
  endpoint: string;
  logsUrl: string;
  tracesUrl: string;
  headers: Record<string, string>;
  serviceName: string;
  serviceVersion: string | undefined;
  environment: string | undefined;
  session: { inactivityTimeoutMs: number; maxDurationMs: number; anonymousId: boolean };
  sampling: { sessionRate: number; bypassCap: number };
  replay: {
    /** False when `replay.mode` is not a technique this platform has: replay stays off. */
    enabled: boolean;
    sessionRate: number;
    bufferRate: number;
    bufferSeconds: number;
    chunkMaxBytes: number;
    chunkMaxMs: number;
    keyframeIntervalMs: number;
  };
  consentRequired: boolean;
  privacy: { urlQueryAllow: ReadonlySet<string>; keepUrlFragment: boolean };
  sanitizeUrl: ((url: string) => string) | undefined;
  beforeSend: BeforeSend | undefined;
  propagation: { urls: UrlPattern[]; sessionBaggage: boolean };
  transport: {
    flushIntervalMs: number;
    maxBatchRecords: number;
    maxRequestBytes: number;
    maxQueueRecords: number;
    shutdownDeadlineMs: number;
    retryInitialMs: number;
    retryMaxMs: number;
    persist: boolean;
    persistTtlMs: number;
    persistMaxBytes: number;
    timeoutMs: number;
  };
  debug: boolean;
  selfDisableThreshold: number;
  instrumentations: {
    errors: boolean;
    webVitals: boolean;
    vitalAttributionBody: boolean;
    clicks: boolean;
    frustration: boolean;
    navigation: boolean;
    hashNavigation: boolean;
    documentLoad: boolean;
    navigationTiming: boolean;
    resourceTiming: boolean;
    fetch: boolean;
    xhr: boolean;
  };
  otel: { registerGlobalProviders: boolean; ignoreUrls: UrlPattern[] };
}

type Note = (key: string, problem: string) => void;
type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag => (v !== null && typeof v === "object" ? (v as Bag) : {});

function num(src: Bag, key: string, path: string, def: number, min: number, max: number, note: Note): number {
  const v = src[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || Number.isNaN(v)) {
    note(path, "not a number, using the default");
    return def;
  }
  if (v < min || v > max) {
    note(path, "out of range, clamped");
    return Math.min(max, Math.max(min, v));
  }
  return v;
}

function bool(src: Bag, key: string, path: string, def: boolean, note: Note): boolean {
  const v = src[key];
  if (v === undefined) return def;
  if (typeof v !== "boolean") {
    note(path, "not a boolean, using the default");
    return def;
  }
  return v;
}

function oneOf<T extends string>(src: Bag, key: string, path: string, allowed: readonly T[], def: T, note: Note): T {
  const v = src[key];
  if (v === undefined) return def;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    note(path, "not one of the allowed values, using the default");
    return def;
  }
  return v as T;
}

function fn<T>(src: Bag, key: string, note: Note): T | undefined {
  const v = src[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "function") {
    note(key, "not a function, ignored");
    return undefined;
  }
  return v as T;
}

function patterns(v: unknown, path: string, note: Note): UrlPattern[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    note(path, "not a list, ignored");
    return [];
  }
  return v.filter((p): p is UrlPattern => (typeof p === "string" && p !== "") || p instanceof RegExp);
}

/** The one replay technique of the web SDK; on the wire it is `ouo.replay.format: "rrweb/2"`. */
export const REPLAY_MODE = "structure/dom";

/**
 * `replay.mode` picks the technique, and the web has one. Unset is `structure/dom`. Anything else
 * (another platform's technique, a shorthand such as `structure` or `pixel`) leaves replay off
 * with a warning: recording with a technique the app did not ask for would be worse than none.
 */
function replayEnabled(replay: Bag, note: Note): boolean {
  const v = replay["mode"];
  if (v === undefined || v === REPLAY_MODE) return true;
  note("replay.mode", `not valid on the web (the only value is "${REPLAY_MODE}"), replay is off`);
  return false;
}

/** A relative endpoint (`/otel`, a first-party proxy route) resolved against the page. */
function resolveEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    const u = new URL(raw.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Credentials never ride in the URL (CFG-3, GR-PRIV-5).
    if (u.username || u.password || u.search) return null;
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** `Authorization` value for a project id and its public token. */
export function basicAuth(projectId: string, projectToken: string): string {
  return `Basic ${base64Utf8(`${projectId}:${projectToken}`)}`;
}

function headers(src: Bag, note: Note): Record<string, string> {
  const out: Record<string, string> = {};
  const h = src["headers"];
  if (h !== undefined && (h === null || typeof h !== "object")) note("headers", "not an object, ignored");
  else
    for (const [k, v] of Object.entries(bag(h))) {
      if (typeof v === "string" && k !== "") out[k] = v;
      else note("headers", "a header value is not a string, ignored");
    }
  const id = src["projectId"];
  const token = src["projectToken"];
  if (id !== undefined || token !== undefined) {
    if (typeof id === "string" && typeof token === "string" && id.trim() !== "" && token.trim() !== "" && !id.includes(":")) {
      if (!Object.keys(out).some((k) => k.toLowerCase() === "authorization")) out["Authorization"] = basicAuth(id.trim(), token.trim());
    } else note("projectId/projectToken", "both must be non-empty strings and the id must not contain a colon; ignored");
  }
  return out;
}

/** The effective configuration, or null when the SDK must stay off. */
export function resolveConfig(input: unknown, note: Note): Config | null {
  if (input === null || typeof input !== "object") {
    note("config", "missing, the SDK is off");
    return null;
  }
  const c = input as Bag;
  if (c["enabled"] === false) return null;
  const endpoint = resolveEndpoint(c["endpoint"]);
  if (!endpoint) {
    note("endpoint", "missing or not an http(s) URL without credentials or query, the SDK is off");
    return null;
  }
  const serviceName = typeof c["serviceName"] === "string" ? c["serviceName"].trim() : "";
  if (serviceName === "") {
    note("serviceName", "missing, the SDK is off");
    return null;
  }
  const str = (key: string): string | undefined => {
    const v = c[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      note(key, "not a non-empty string, ignored");
      return undefined;
    }
    return v.trim();
  };

  const session = bag(c["session"]);
  const sampling = bag(c["sampling"]);
  const replay = bag(c["replay"]);
  const privacy = bag(c["privacy"]);
  const propagation = bag(c["propagation"]);
  const transport = bag(c["transport"]);
  const retry = bag(transport["retry"]);
  const persist = bag(transport["persist"]);
  const inst = bag(c["instrumentations"]);
  const otel = bag(c["otel"]);

  const allow = privacy["urlQueryAllow"];
  if (allow !== undefined && !Array.isArray(allow)) note("privacy.urlQueryAllow", "not a list, ignored");

  return {
    endpoint,
    logsUrl: `${endpoint}/v1/logs`,
    tracesUrl: `${endpoint}/v1/traces`,
    headers: headers(c, note),
    serviceName,
    serviceVersion: str("serviceVersion"),
    environment: str("environment"),
    session: {
      inactivityTimeoutMs: num(session, "inactivityTimeoutMs", "session.inactivityTimeoutMs", 30 * MIN, MIN, 24 * HOUR, note),
      maxDurationMs: num(session, "maxDurationMs", "session.maxDurationMs", 4 * HOUR, MIN, 24 * HOUR, note),
      anonymousId: bool(session, "anonymousId", "session.anonymousId", false, note),
    },
    sampling: {
      sessionRate: num(sampling, "sessionRate", "sampling.sessionRate", 1, 0, 1, note),
      bypassCap: Math.floor(num(bag(sampling["bypass"]), "perSessionCap", "sampling.bypass.perSessionCap", 10, 0, 1000, note)),
    },
    replay: {
      enabled: replayEnabled(replay, note),
      sessionRate: num(replay, "sessionRate", "replay.sessionRate", 0, 0, 1, note),
      bufferRate: num(replay, "bufferRate", "replay.bufferRate", 0, 0, 1, note),
      bufferSeconds: num(replay, "bufferSeconds", "replay.bufferSeconds", 60, 5, 600, note),
      chunkMaxBytes: num(replay, "chunkMaxBytes", "replay.chunkMaxBytes", 256 * 1024, 4 * 1024, CHUNK_HARD_LIMIT, note),
      chunkMaxMs: num(replay, "chunkMaxMs", "replay.chunkMaxMs", 5000, 250, 60_000, note),
      keyframeIntervalMs: num(replay, "keyframeIntervalMs", "replay.keyframeIntervalMs", 300_000, 5000, HOUR, note),
    },
    consentRequired: bool(bag(c["consent"]), "required", "consent.required", false, note),
    privacy: {
      urlQueryAllow: new Set(Array.isArray(allow) ? allow.filter((k): k is string => typeof k === "string") : []),
      keepUrlFragment: bool(privacy, "keepUrlFragment", "privacy.keepUrlFragment", false, note),
    },
    sanitizeUrl: fn(c, "sanitizeUrl", note),
    beforeSend: fn(c, "beforeSend", note),
    propagation: {
      urls: patterns(propagation["urls"], "propagation.urls", note),
      sessionBaggage: bool(propagation, "sessionBaggage", "propagation.sessionBaggage", false, note),
    },
    transport: {
      flushIntervalMs: num(transport, "flushIntervalMs", "transport.flushIntervalMs", 5000, 250, 60_000, note),
      maxBatchRecords: Math.floor(num(transport, "maxBatchRecords", "transport.maxBatchRecords", 512, 1, 4096, note)),
      maxRequestBytes: num(transport, "maxRequestBytes", "transport.maxRequestBytes", 1024 * 1024, 8 * 1024, 4 * 1024 * 1024, note),
      maxQueueRecords: Math.floor(num(transport, "maxQueueRecords", "transport.maxQueueRecords", 2048, 16, 16_384, note)),
      shutdownDeadlineMs: num(transport, "shutdownDeadlineMs", "transport.shutdownDeadlineMs", 2000, 0, 30_000, note),
      retryInitialMs: num(retry, "initialMs", "transport.retry.initialMs", 1000, 10, 60_000, note),
      retryMaxMs: num(retry, "maxMs", "transport.retry.maxMs", 300_000, 100, HOUR, note),
      persist: bool(persist, "enabled", "transport.persist.enabled", true, note),
      persistTtlMs: num(persist, "ttlHours", "transport.persist.ttlHours", 72, 1, 24 * 30, note) * HOUR,
      persistMaxBytes: num(persist, "maxBytes", "transport.persist.maxBytes", 5 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024, note),
      timeoutMs: num(transport, "timeoutMs", "transport.timeoutMs", 30_000, 1000, 120_000, note),
    },
    debug: bool(c, "debug", "debug", false, note),
    selfDisableThreshold: Math.floor(num(bag(c["diagnostics"]), "selfDisableThreshold", "diagnostics.selfDisableThreshold", 20, 1, 10_000, note)),
    instrumentations: {
      errors: bool(inst, "errors", "instrumentations.errors", true, note),
      webVitals: bool(inst, "webVitals", "instrumentations.webVitals", true, note),
      vitalAttributionBody: bool(inst, "vitalAttributionBody", "instrumentations.vitalAttributionBody", false, note),
      clicks: bool(inst, "clicks", "instrumentations.clicks", true, note),
      frustration: bool(inst, "frustration", "instrumentations.frustration", true, note),
      navigation: bool(inst, "navigation", "instrumentations.navigation", true, note),
      hashNavigation: bool(inst, "hashNavigation", "instrumentations.hashNavigation", false, note),
      documentLoad: bool(inst, "documentLoad", "instrumentations.documentLoad", true, note),
      navigationTiming: bool(inst, "navigationTiming", "instrumentations.navigationTiming", true, note),
      resourceTiming: bool(inst, "resourceTiming", "instrumentations.resourceTiming", false, note),
      fetch: bool(inst, "fetch", "instrumentations.fetch", true, note),
      xhr: bool(inst, "xhr", "instrumentations.xhr", true, note),
    },
    otel: {
      registerGlobalProviders: bool(otel, "registerGlobalProviders", "otel.registerGlobalProviders", false, note),
      ignoreUrls: patterns(otel["ignoreUrls"], "otel.ignoreUrls", note),
    },
  };
}

/** Whether `url` matches one of `patterns` (exact string, prefix ending in `*`, or RegExp). */
export function matchesUrl(patternList: readonly UrlPattern[], url: string): boolean {
  for (const p of patternList) {
    if (typeof p === "string") {
      if (p.endsWith("*") ? url.startsWith(p.slice(0, -1)) : url === p) return true;
    } else {
      p.lastIndex = 0;
      if (p.test(url)) return true;
    }
  }
  return false;
}
