/**
 * Ingest gateway wiring (ADR-0007). The SDK talks to one host, rum-api, which validates
 * the project token and forwards OTLP to the collector. Pure helpers, no I/O.
 */

/** Request header carrying the public project identifier on every ingest request. */
export const PROJECT_TOKEN_HEADER = "X-Ouo-Project-Token";

/** rum-api route prefix that accepts stock OTLP/HTTP (`/v1/traces`, `/v1/logs`, `/v1/metrics` below it). */
export const OTLP_INGEST_PATH = "/ingest/otlp";

export const REPLAY_CHUNKS_PATH = "/v1/replay/chunks";

export interface IngestInput {
  /** rum-api base URL. */
  endpoint: string;
  /** Public project token; required, non-empty. */
  projectToken: string;
  /** Escape hatch: a trusted in-network OTLP/HTTP base that bypasses rum-api for traces and logs. */
  otlpEndpoint?: string | undefined;
}

export interface IngestUrls {
  /** rum-api base, trailing slashes removed. */
  endpoint: string;
  /** OTLP/HTTP base the exporters append `/v1/traces` and `/v1/logs` to. */
  otlpBase: string;
  traces: string;
  logs: string;
  replay: string;
  /** True when `otlpEndpoint` was given and OTLP bypasses rum-api. */
  otlpBypass: boolean;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Validates the token and derives every URL the SDK posts to. Throws on a missing or
 * empty token or an empty endpoint so a misconfigured app fails at init, not silently.
 */
export function deriveIngestUrls(input: IngestInput): IngestUrls {
  if (typeof input.endpoint !== "string" || input.endpoint.trim() === "") {
    throw new Error("[ouo] initRUM: `endpoint` (the rum-api base URL) is required");
  }
  if (typeof input.projectToken !== "string" || input.projectToken.trim() === "") {
    throw new Error(
      "[ouo] initRUM: `projectToken` is required. It is the public project identifier from your ouo project settings (ADR-0007); pass it as `initRUM({ endpoint, projectToken, ... })`.",
    );
  }
  const endpoint = trimSlash(input.endpoint.trim());
  const otlpBypass = typeof input.otlpEndpoint === "string" && input.otlpEndpoint.trim() !== "";
  const otlpBase = otlpBypass ? trimSlash(input.otlpEndpoint!.trim()) : `${endpoint}${OTLP_INGEST_PATH}`;
  return {
    endpoint,
    otlpBase,
    traces: `${otlpBase}/v1/traces`,
    logs: `${otlpBase}/v1/logs`,
    replay: `${endpoint}${REPLAY_CHUNKS_PATH}`,
    otlpBypass,
  };
}

/** Headers attached to every OTLP export and replay chunk upload. */
export function projectTokenHeaders(projectToken: string): Record<string, string> {
  return { [PROJECT_TOKEN_HEADER]: projectToken };
}
