/**
 * Ingest URLs and the credential derived from `initRUM({ endpoint, replayEndpoint, projectId,
 * projectToken })` (ADR-0007 section 6).
 *
 * The OpenTelemetry Collector (`ouo-collector`) is the only edge. `endpoint` is its OTLP/HTTP
 * base: traces go to `${endpoint}/v1/traces`, events (logs) to `${endpoint}/v1/logs`. Replay
 * chunks go to `${replayEndpoint}/v1/replay/chunks`, the collector's `ouoreplay` receiver, which
 * listens on its own port (4319 next to OTLP's 4318) unless a proxy folds both behind one host.
 * Every request carries `Authorization: Basic base64("<projectId>:<projectToken>")`.
 */

/** Header every ingest request carries (ADR-0007 section 2). */
export const AUTHORIZATION_HEADER = "Authorization";

/** Default OTLP/HTTP port of the collector; when `endpoint` uses it, replay defaults to the next one. */
export const DEFAULT_OTLP_PORT = 4318;
/** Default port of the collector's `ouoreplay` receiver. */
export const DEFAULT_REPLAY_PORT = 4319;
export const REPLAY_CHUNKS_PATH = "/v1/replay/chunks";

export interface EndpointOptions {
  endpoint: string;
  replayEndpoint?: string | undefined;
}

export interface ResolvedEndpoints {
  /** Collector OTLP/HTTP base URL without a trailing slash. */
  endpoint: string;
  traces: string;
  logs: string;
  /** Base URL the native recorder receives; chunks go to `${replayEndpoint}/v1/replay/chunks`. */
  replayEndpoint: string;
  replayChunks: string;
  /** True when `replayEndpoint` was derived (port 4318 to 4319, else the endpoint itself). */
  replayEndpointDerived: boolean;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// `scheme://authority` where the authority ends in `:4318` (host names, IPv4 and bracketed IPv6).
const OTLP_PORT_RE = new RegExp(`^([a-z][a-z0-9+.-]*://[^/?#]*?):${DEFAULT_OTLP_PORT}(?=[/?#]|$)`, "i");

/**
 * ADR-0007 section 6: the replay endpoint defaults to `endpoint` with port 4318 replaced by
 * 4319; any other endpoint (a proxy such as `https://otel.example.com` that routes
 * `/v1/replay/*` itself) is used as is.
 */
export function defaultReplayEndpoint(endpoint: string): string {
  const base = trimSlash(endpoint.trim());
  return OTLP_PORT_RE.test(base) ? base.replace(OTLP_PORT_RE, `$1:${DEFAULT_REPLAY_PORT}`) : base;
}

/** Pure: derives every ingest URL from the options. Throws on an empty `endpoint`. */
export function resolveEndpoints(options: EndpointOptions): ResolvedEndpoints {
  const endpoint = trimSlash(String(options.endpoint ?? "").trim());
  if (!endpoint) {
    throw new TypeError(
      "[ouo] initRUM: `endpoint` (the collector OTLP/HTTP base URL, for example https://otel.example.com or http://localhost:4318) is required",
    );
  }
  const explicitReplay = options.replayEndpoint ? trimSlash(options.replayEndpoint.trim()) : "";
  const replayEndpoint = explicitReplay || defaultReplayEndpoint(endpoint);
  return {
    endpoint,
    traces: `${endpoint}/v1/traces`,
    logs: `${endpoint}/v1/logs`,
    replayEndpoint,
    replayChunks: `${replayEndpoint}${REPLAY_CHUNKS_PATH}`,
    replayEndpointDerived: explicitReplay === "",
  };
}

export interface ProjectCredentials {
  projectId: string;
  projectToken: string;
}

function requireNonEmpty(name: "projectId" | "projectToken", value: unknown, hint: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `[ouo] initRUM: \`${name}\` is required (ADR-0007). ${hint} For example initRUM({ endpoint: "https://otel.example.com", projectId: "web-store", projectToken: "pt_live_...", service: { ... } }). The collector answers 401 without the credential.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.includes(":") && name === "projectId") {
    throw new TypeError(`[ouo] initRUM: \`projectId\` must not contain ":" (it is the user name of the HTTP Basic credential)`);
  }
  return trimmed;
}

/**
 * Validates the project id and token. They are public, so the only mistakes worth catching are
 * the ones that give a 401 on every request: missing, empty, not a string, surrounding
 * whitespace, a colon in the id (Basic auth splits user name and password on the first colon).
 */
export function requireCredentials(options: { projectId?: unknown; projectToken?: unknown }): ProjectCredentials {
  const projectId = requireNonEmpty("projectId", options.projectId, "Pass the project id from your ouo project settings (the user name of the Basic credential).");
  const projectToken = requireNonEmpty("projectToken", options.projectToken, "Pass the project token from your ouo project settings (the password of the Basic credential).");
  return { projectId, projectToken };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** UTF-8 bytes of a string without `TextEncoder` (older Hermes) and without `Buffer` (not in RN). */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/**
 * Standard base64 (RFC 4648, with padding) of the UTF-8 bytes of `s`. React Native does not
 * guarantee `btoa` on every runtime (Hermes gained it late and Node has `Buffer` instead), so
 * the SDK carries its own 20-line encoder rather than a polyfill dependency.
 */
export function base64Encode(s: string): string {
  const bytes = utf8Bytes(s);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
}

/** `Basic base64("<projectId>:<projectToken>")`, the value of the `Authorization` header (ADR-0007). */
export function basicAuthorization(projectId: string, projectToken: string): string {
  return `Basic ${base64Encode(`${projectId}:${projectToken}`)}`;
}

/** Headers every OTLP export request carries. */
export function ingestHeaders(authorization: string): Record<string, string> {
  return { [AUTHORIZATION_HEADER]: authorization };
}
