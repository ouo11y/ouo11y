/**
 * Ingest wiring (ADR-0007, revised): the OpenTelemetry Collector is the only edge. OTLP goes
 * to `${endpoint}/v1/traces` and `/v1/logs`, replay chunks to `${replayEndpoint}/v1/replay/chunks`,
 * every request carrying `Authorization: Basic base64(projectId:projectToken)`. Pure helpers, no I/O.
 */

/** Header carrying the project credential on every ingest request (OTLP and replay). */
export const AUTHORIZATION_HEADER = "Authorization";

/** Collector OTLP/HTTP port; when `endpoint` uses it the replay receiver is assumed on the next port. */
export const OTLP_HTTP_PORT = "4318";
export const REPLAY_PORT = "4319";

export const TRACES_PATH = "/v1/traces";
export const LOGS_PATH = "/v1/logs";
export const REPLAY_CHUNKS_PATH = "/v1/replay/chunks";

export interface IngestInput {
  /** Collector OTLP/HTTP base URL. */
  endpoint: string;
  /** Replay receiver base URL; derived from `endpoint` when absent. */
  replayEndpoint?: string | undefined;
  /** Project id: the Basic auth username. Required, non-empty, no `:`. */
  projectId: string;
  /** Public project token: the Basic auth password. Required, non-empty. */
  projectToken: string;
}

export interface IngestUrls {
  /** Collector OTLP/HTTP base, trailing slashes removed. */
  endpoint: string;
  /** Replay receiver base, trailing slashes removed. */
  replayEndpoint: string;
  traces: string;
  logs: string;
  replay: string;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** base64 of the UTF-8 bytes of `input` (`btoa` alone throws on code points above U+00FF). */
export function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  if (typeof btoa === "function") return btoa(binary);
  // Runtimes without btoa (old Node): Buffer is there instead.
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  throw new Error("[ouo] no base64 encoder available (btoa or Buffer)");
}

function requireNonEmpty(value: unknown, name: string, hint: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[ouo] initRUM: \`${name}\` is required. ${hint}`);
  }
  return value.trim();
}

/**
 * The value of the `Authorization` header: `Basic base64("<projectId>:<projectToken>")`.
 * Throws when either part is missing, or when the id contains `:` (it would split the credential).
 */
export function basicAuthorization(projectId: string, projectToken: string): string {
  const id = requireNonEmpty(projectId, "projectId", "It is the project identifier (the Basic auth username) from your ouo project settings (ADR-0007); pass it as `initRUM({ endpoint, projectId, projectToken, ... })`.");
  const token = requireNonEmpty(projectToken, "projectToken", "It is the public project token (the Basic auth password) from your ouo project settings (ADR-0007); pass it as `initRUM({ endpoint, projectId, projectToken, ... })`.");
  if (id.includes(":")) throw new Error("[ouo] initRUM: `projectId` must not contain `:` (HTTP Basic splits the credential at the first colon)");
  return `Basic ${base64Utf8(`${id}:${token}`)}`;
}

/** Headers attached to every OTLP export and replay chunk upload. */
export function ingestHeaders(authorization: string): Record<string, string> {
  return { [AUTHORIZATION_HEADER]: authorization };
}

/**
 * Default replay base: when `endpoint` uses port 4318 (the collector's OTLP/HTTP port) the
 * replay receiver is on 4319 with the same scheme, host and path; otherwise (a reverse proxy
 * routing `/v1/replay/*` itself, or any other port) it is `endpoint`.
 */
export function deriveReplayEndpoint(endpoint: string): string {
  const base = trimSlash(endpoint.trim());
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return base;
  }
  if (u.port !== OTLP_HTTP_PORT) return base;
  u.port = REPLAY_PORT;
  return trimSlash(u.href);
}

/**
 * Validates the credential parts and derives every URL the SDK posts to. Throws on a missing
 * id, token or endpoint so a misconfigured app fails at init, not silently.
 */
export function deriveIngestUrls(input: IngestInput): IngestUrls {
  const endpoint = trimSlash(requireNonEmpty(input.endpoint, "endpoint", "It is the collector's OTLP/HTTP base URL, for example `https://otel.example.com` or `http://localhost:4318`."));
  // Validate the credential here too so a bad id or token fails before any URL is used.
  basicAuthorization(input.projectId, input.projectToken);
  const replayEndpoint =
    typeof input.replayEndpoint === "string" && input.replayEndpoint.trim() !== ""
      ? trimSlash(input.replayEndpoint.trim())
      : deriveReplayEndpoint(endpoint);
  return {
    endpoint,
    replayEndpoint,
    traces: `${endpoint}${TRACES_PATH}`,
    logs: `${endpoint}${LOGS_PATH}`,
    replay: `${replayEndpoint}${REPLAY_CHUNKS_PATH}`,
  };
}
