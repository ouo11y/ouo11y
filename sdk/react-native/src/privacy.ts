import { guard } from "./guard";

/**
 * URL sanitising (spec PRV-10, PRV-11), applied to every URL the SDK records before the record
 * is kept or sent: `url.full` of request spans and request events (and their bodies) and URLs in
 * `exception.stacktrace`.
 *
 * 1. Credentials (`user:password@`) become `REDACTED:REDACTED@`.
 * 2. Every query value becomes `REDACTED`, unless its key is in `privacy.urlQueryAllow`.
 * 3. The fragment is removed; with `privacy.keepUrlFragment` it is kept, and a query-shaped
 *    fragment (`#a=1&b=2`, `#/path?a=1`) is sanitised like a query.
 * 4. The app's `sanitizeUrl` hook runs on the result. A hook that throws or returns something
 *    that is not a string leaves the result of steps 1 to 3.
 *
 * Stricter than the OpenTelemetry default, which redacts only a list of known keys.
 */

export const REDACTED = "REDACTED";

export interface UrlPrivacy {
  /** Query keys whose values are kept. Compared as written (case-sensitive). */
  queryAllow?: readonly string[];
  keepFragment?: boolean;
  /** The app's hook: gets the sanitised URL, returns the URL to record. */
  hook?: ((url: string) => string) | undefined;
}

export type UrlSanitizer = (url: string) => string;

function sanitizeQuery(query: string, allow: ReadonlySet<string>): string {
  return query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      let name = key;
      try {
        name = decodeURIComponent(key.replace(/\+/g, " "));
      } catch {
        // a malformed escape: compare the key as written
      }
      return allow.has(name) || allow.has(key) ? pair : `${key}=${REDACTED}`;
    })
    .join("&");
}

/** Steps 1 to 3, without the hook. Never throws; a string that is not a URL is treated the same way. */
export function redactUrl(url: string, allow: ReadonlySet<string> = new Set(), keepFragment = false): string {
  const hash = url.indexOf("#");
  let fragment = hash >= 0 ? url.slice(hash + 1) : undefined;
  let rest = hash >= 0 ? url.slice(0, hash) : url;
  const q = rest.indexOf("?");
  const query = q >= 0 ? rest.slice(q + 1) : undefined;
  if (q >= 0) rest = rest.slice(0, q);
  // `scheme://user:password@host`: the userinfo ends at the last `@` of the authority.
  rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)@/i, `$1${REDACTED}:${REDACTED}@`);
  let out = query === undefined ? rest : `${rest}?${sanitizeQuery(query, allow)}`;
  if (keepFragment && fragment !== undefined) {
    const fq = fragment.indexOf("?");
    if (fq >= 0) fragment = `${fragment.slice(0, fq)}?${sanitizeQuery(fragment.slice(fq + 1), allow)}`;
    else if (fragment.includes("=")) fragment = sanitizeQuery(fragment, allow);
    out += `#${fragment}`;
  }
  return out;
}

export function createUrlSanitizer(privacy: UrlPrivacy = {}): UrlSanitizer {
  const allow = new Set(privacy.queryAllow ?? []);
  const hook = privacy.hook;
  // What this sanitizer returned lately: a URL sanitised where it was captured (a request) is
  // not put through the hook a second time when its record passes the gate.
  const done = new Set<string>();
  return (url) => {
    if (typeof url !== "string" || url === "" || done.has(url)) return url;
    const redacted = redactUrl(url, allow, privacy.keepFragment === true);
    const hooked = hook ? guard.host("sanitizeUrl", () => hook(redacted)) : redacted;
    const out = typeof hooked === "string" ? hooked : redacted;
    if (done.size >= 256) done.clear();
    done.add(out);
    return out;
  };
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s()<>"']+/gi;
const POSITION = /(:\d+(?::\d+)?)$/;

/** Sanitises every URL inside a stack trace; a frame's `:line:column` suffix is kept. */
export function sanitizeUrlsInText(text: string, sanitize: UrlSanitizer): string {
  if (!text.includes("://")) return text;
  return text.replace(URL_IN_TEXT, (match) => {
    const position = POSITION.exec(match)?.[1] ?? "";
    return sanitize(position ? match.slice(0, -position.length) : match) + position;
  });
}
