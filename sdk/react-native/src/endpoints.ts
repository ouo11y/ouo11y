/**
 * Ingest URLs derived from `initRUM({ endpoint, otlpEndpoint })` (ADR-0007 section 7).
 *
 * `endpoint` is the rum-api base URL. OTLP goes to `${endpoint}/ingest/otlp/v1/{traces,logs}`
 * and replay chunks to `${endpoint}/v1/replay/chunks`, all with the `X-Ouo-Project-Token`
 * header. `otlpEndpoint` is the escape hatch for a trusted in-network app that may talk to
 * the collector directly: OTLP then goes to `${otlpEndpoint}/v1/{traces,logs}`, replay still
 * goes through rum-api.
 */

/** Header that identifies the project on every ingest request. Public by nature (ADR-0007). */
export const PROJECT_TOKEN_HEADER = "X-Ouo-Project-Token";

/** Path prefix rum-api mounts the OTLP/HTTP receiver on. */
export const INGEST_OTLP_PATH = "/ingest/otlp";
export const REPLAY_CHUNKS_PATH = "/v1/replay/chunks";

export interface EndpointOptions {
  endpoint: string;
  otlpEndpoint?: string | undefined;
}

export interface ResolvedEndpoints {
  /** rum-api base URL without a trailing slash. */
  rumApi: string;
  /** OTLP/HTTP base URL the exporters append `/v1/traces` and `/v1/logs` to. */
  otlpBase: string;
  traces: string;
  logs: string;
  /** Base URL the native recorder receives; chunks go to `${replayEndpoint}/v1/replay/chunks`. */
  replayEndpoint: string;
  replayChunks: string;
  /** True when `otlpEndpoint` bypasses rum-api. */
  otlpBypassesRumApi: boolean;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Pure: derives every ingest URL from the options. Throws on an empty `endpoint`. */
export function resolveEndpoints(options: EndpointOptions): ResolvedEndpoints {
  const rumApi = trimSlash(String(options.endpoint ?? "").trim());
  if (!rumApi) {
    throw new TypeError("[ouo] initRUM: `endpoint` (the rum-api base URL, for example https://rum.example.com) is required");
  }
  const otlpOverride = options.otlpEndpoint ? trimSlash(options.otlpEndpoint.trim()) : "";
  const otlpBase = otlpOverride || `${rumApi}${INGEST_OTLP_PATH}`;
  return {
    rumApi,
    otlpBase,
    traces: `${otlpBase}/v1/traces`,
    logs: `${otlpBase}/v1/logs`,
    replayEndpoint: rumApi,
    replayChunks: `${rumApi}${REPLAY_CHUNKS_PATH}`,
    otlpBypassesRumApi: otlpOverride !== "",
  };
}

/**
 * Validates the project token. It is public, so the only mistakes worth catching are the
 * ones that give a 401 on every request: missing, empty, not a string, surrounding whitespace.
 */
export function requireProjectToken(token: unknown): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new TypeError(
      "[ouo] initRUM: `projectToken` is required (ADR-0007). Pass the project token from your ouo project settings, for example initRUM({ endpoint: \"https://rum.example.com\", projectToken: \"pt_live_...\", service: { ... } }). rum-api answers 401 without it.",
    );
  }
  return token.trim();
}

/** Headers every OTLP export request carries. */
export function ingestHeaders(projectToken: string): Record<string, string> {
  return { [PROJECT_TOKEN_HEADER]: projectToken };
}
