import { requireCredentials, resolveEndpoints, type ResolvedEndpoints } from "./endpoints";
import { DEFAULT_SELF_DISABLE_THRESHOLD } from "./guard";
import { sampleRate } from "./sampling";
import { DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_MAX_DURATION_MS } from "./session/manager";
import type { BeforeSend, RUMOptions, ServiceOptions } from "./types";

/** Spec CFG-2: inactivity and background timeouts are at least a minute, the maximum duration at most a day. */
export const MIN_TIMEOUT_MS = 60 * 1000;
export const MAX_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 2000;
export const DEFAULT_FATAL_FLUSH_TIMEOUT_MS = 2000;

/** The options `init` works with: validated, defaulted and clamped. `options` holds the rest as given. */
export interface Config {
  endpoints: ResolvedEndpoints;
  projectId: string;
  projectToken: string;
  service: ServiceOptions;
  session: { inactivityTimeoutMs: number; maxDurationMs: number; backgroundTimeoutMs: number; sampleRate: number };
  selfDisableThreshold: number;
  shutdownDeadlineMs: number;
  fatalFlushTimeoutMs: number;
  beforeSend: BeforeSend | undefined;
  registerGlobal: boolean;
  debug: boolean;
  options: RUMOptions;
}

export interface NormalizedOptions {
  /** Undefined when the SDK cannot run (CFG-1): `init` then returns a no-op instance. */
  config: Config | undefined;
  /** What was wrong, for the debug log. Never contains a credential (CFG-3). */
  diagnostics: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/**
 * The one place options are read (spec CFG-1, CFG-2, CFG-3). Never throws: a missing or invalid
 * `endpoint`, `projectId`, `projectToken` or `service.name` gives no config (the SDK is a
 * no-op); any other invalid value falls back to its default; out-of-range values are clamped.
 */
export function normalizeOptions(input: unknown): NormalizedOptions {
  const diagnostics: string[] = [];
  const fatal = (message: string): NormalizedOptions => ({ config: undefined, diagnostics: [...diagnostics, `${message}; the SDK is a no-op`] });
  try {
    if (!isObject(input)) return fatal("init: options must be an object");
    const options = input as unknown as RUMOptions;

    let endpoints: ResolvedEndpoints;
    try {
      if (typeof options.endpoint !== "string" || !/^https?:\/\/[^\s/?#]+/i.test(options.endpoint.trim())) throw new Error("not an http(s) URL");
      endpoints = resolveEndpoints({
        endpoint: options.endpoint,
        ...(typeof options.replayEndpoint === "string" ? { replayEndpoint: options.replayEndpoint } : {}),
      });
    } catch {
      return fatal("init: `endpoint` (the collector OTLP/HTTP base URL, for example https://otel.example.com) is missing or invalid");
    }

    let credentials: { projectId: string; projectToken: string };
    try {
      credentials = requireCredentials(options);
    } catch {
      // The reason is not repeated: it could quote the value.
      return fatal('init: `projectId` and `projectToken` are required non-empty strings (and `projectId` has no ":")');
    }

    const service = isObject(options.service) ? (options.service as unknown as Partial<ServiceOptions>) : {};
    if (typeof service.name !== "string" || service.name.trim() === "") return fatal("init: `service.name` is missing or invalid");
    const text = (key: "version" | "environment"): string => {
      const v = service[key];
      if (typeof v === "string" && v !== "") return v;
      diagnostics.push(`service.${key} is missing or not a string: using "unknown"`);
      return "unknown";
    };

    const duration = (name: string, value: unknown, fallback: number, min: number, max: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        diagnostics.push(`${name} is not a positive number: using the default ${fallback}`);
        return fallback;
      }
      const clamped = Math.min(max, Math.max(min, value));
      if (clamped !== value) diagnostics.push(`${name} ${value} is out of range: using ${clamped}`);
      return clamped;
    };
    const rate = (name: string, value: unknown, fallback: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || Number.isNaN(value)) {
        diagnostics.push(`${name} is not a number: using the default ${fallback}`);
        return fallback;
      }
      const clamped = sampleRate(value, fallback);
      if (clamped !== value) diagnostics.push(`${name} ${value} is out of range: using ${clamped}`);
      return clamped;
    };
    const section = <K extends keyof RUMOptions>(key: K): Record<string, unknown> => {
      const v = options[key];
      if (v !== undefined && !isObject(v)) diagnostics.push(`${key} is not an object: ignored`);
      return isObject(v) ? v : {};
    };

    const session = section("session");
    const transport = section("transport");
    const errors = section("errors");
    const diagnosticsOptions = section("diagnostics");
    const otel = section("otel");

    let beforeSend: BeforeSend | undefined;
    if (typeof options.beforeSend === "function") beforeSend = options.beforeSend;
    else if (options.beforeSend !== undefined) diagnostics.push("beforeSend is not a function: ignored");

    return {
      config: {
        endpoints,
        ...credentials,
        service: { name: service.name, version: text("version"), environment: text("environment") },
        session: {
          inactivityTimeoutMs: duration("session.inactivityTimeoutMs", session["inactivityTimeoutMs"], DEFAULT_INACTIVITY_TIMEOUT_MS, MIN_TIMEOUT_MS, Infinity),
          maxDurationMs: duration("session.maxDurationMs", session["maxDurationMs"], DEFAULT_MAX_DURATION_MS, MIN_TIMEOUT_MS, MAX_SESSION_DURATION_MS),
          backgroundTimeoutMs: duration("session.backgroundTimeoutMs", session["backgroundTimeoutMs"], DEFAULT_BACKGROUND_TIMEOUT_MS, MIN_TIMEOUT_MS, Infinity),
          sampleRate: rate("session.sampleRate", session["sampleRate"], 1),
        },
        selfDisableThreshold: Math.floor(duration("diagnostics.selfDisableThreshold", diagnosticsOptions["selfDisableThreshold"], DEFAULT_SELF_DISABLE_THRESHOLD, 1, Infinity)),
        shutdownDeadlineMs: duration("transport.shutdownDeadlineMs", transport["shutdownDeadlineMs"], DEFAULT_SHUTDOWN_DEADLINE_MS, 0, 30_000),
        fatalFlushTimeoutMs: duration("errors.fatalFlushTimeoutMs", errors["fatalFlushTimeoutMs"], DEFAULT_FATAL_FLUSH_TIMEOUT_MS, 0, 30_000),
        beforeSend,
        registerGlobal: otel["registerGlobal"] === true,
        debug: options.debug === true,
        options,
      },
      diagnostics,
    };
  } catch {
    // A getter that throws, a revoked proxy: still not the app's problem.
    return fatal("init: the options could not be read");
  }
}
