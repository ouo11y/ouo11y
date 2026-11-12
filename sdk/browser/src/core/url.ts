/**
 * URL sanitising (PRV-10, PRV-11). Runs before anything is persisted or exported, on
 * `url.full`, `browser.document.url.full`, stack frames and replay URLs: credentials become
 * `REDACTED:REDACTED`, every query value becomes `REDACTED` unless its key is allowed, and the
 * fragment is removed unless kept (a query-shaped fragment is then sanitised the same way). The
 * app's `sanitizeUrl` hook runs last; a hook that throws or returns a non-string is ignored.
 */
export interface UrlPolicy {
  queryAllow: ReadonlySet<string>;
  keepFragment: boolean;
  hook?: ((url: string) => string) | undefined;
}

const REDACTED = "REDACTED";

function sanitizeQuery(query: string, allow: ReadonlySet<string>): string {
  if (query === "") return "";
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
        // An undecodable key is compared as written.
      }
      return allow.has(name) ? pair : `${key}=${REDACTED}`;
    })
    .join("&");
}

function sanitizeFragment(fragment: string, allow: ReadonlySet<string>): string {
  // `#/route?a=1` (hash routers) or `#a=1&b=2` (OAuth implicit flow).
  const q = fragment.indexOf("?");
  if (q >= 0) return `${fragment.slice(0, q)}?${sanitizeQuery(fragment.slice(q + 1), allow)}`;
  return fragment.includes("=") ? sanitizeQuery(fragment, allow) : fragment;
}

/** The built-in rules, without the hook. Works on absolute and relative URLs without resolving them. */
export function redactUrl(url: string, policy: Pick<UrlPolicy, "queryAllow" | "keepFragment">): string {
  let rest = url;
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query: string | undefined;
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  // scheme://user:pass@host -> scheme://REDACTED:REDACTED@host
  rest = rest.replace(/^([a-z][a-z\d+.-]*:)?\/\/[^/@]*@/i, (_m, scheme: string | undefined) => `${scheme ?? ""}//${REDACTED}:${REDACTED}@`);
  let out = rest;
  if (query !== undefined) out += `?${sanitizeQuery(query, policy.queryAllow)}`;
  if (policy.keepFragment && hash >= 0) out += `#${sanitizeFragment(fragment, policy.queryAllow)}`;
  return out;
}

export function sanitizeUrl(url: string, policy: UrlPolicy): string {
  const clean = redactUrl(url, policy);
  if (!policy.hook) return clean;
  try {
    const out = policy.hook(clean);
    return typeof out === "string" ? out : clean;
  } catch {
    return clean;
  }
}

const URL_IN_TEXT = /\b(?:https?|wss?|file|blob|[a-z-]+-extension):\/\/[^\s()<>"']+/gi;

/** Sanitises every URL inside a stack trace, keeping each frame's `:line:column`. */
export function sanitizeStack(stack: string, policy: UrlPolicy): string {
  // Cheap exit: most stacks carry no query, fragment or credential at all.
  if (!/[?#@]/.test(stack)) return stack;
  return stack.replace(URL_IN_TEXT, (match) => {
    const pos = /(:\d+){1,2}$/.exec(match);
    const url = pos ? match.slice(0, pos.index) : match;
    return sanitizeUrl(url, policy) + (pos ? pos[0] : "");
  });
}
