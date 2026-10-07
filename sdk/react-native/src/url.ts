/**
 * URL pieces the fetch wrapper needs, without relying on the global `URL`, whose React
 * Native polyfill historically throws on `hostname` / `origin`.
 */
export interface ParsedUrl {
  scheme: string;
  host: string;
  port: number | undefined;
  path: string;
}

const ABSOLUTE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;

export function parseUrl(url: string): ParsedUrl | undefined {
  const m = ABSOLUTE.exec(url);
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  let authority = m[2]!;
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority;
  let port: number | undefined;
  const portMatch = /^(.*):(\d+)$/.exec(authority);
  if (portMatch && !authority.startsWith("[") ) {
    host = portMatch[1]!;
    port = Number(portMatch[2]);
  } else if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest.startsWith(":")) port = Number(rest.slice(1));
  }
  if (port === undefined) port = scheme === "https" ? 443 : scheme === "http" ? 80 : undefined;
  return { scheme, host, port, path: m[3] || "/" };
}

export function matchesAny(url: string, patterns: Array<RegExp | string>): boolean {
  for (const p of patterns) {
    if (typeof p === "string") {
      if (url === p || url.startsWith(p)) return true;
    } else if (p.test(url)) {
      return true;
    }
  }
  return false;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
