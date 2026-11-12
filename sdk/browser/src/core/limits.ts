/** Attribute limits at source (REC-8) and the names an app may not set (API-3). */

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export const MAX_STRING_BYTES = 4 * 1024;
export const MAX_STACK_BYTES = 25 * 1024;
/** Upper bound of attributes an app can attach to one record (ERR-9). */
export const MAX_APP_ATTRIBUTES = 64;

/** Cuts `s` to at most `maxBytes` of UTF-8, keeping the start (the top frames of a stack). */
export function truncate(s: string, maxBytes: number): string {
  // UTF-16 length is a lower bound of the UTF-8 length; three bytes per unit is the upper bound.
  if (s.length * 3 <= maxBytes) return s;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (bytes + size > maxBytes) return s.slice(0, i);
    bytes += size;
    if (size === 4) i++; // The low surrogate belongs to this code point.
  }
  return s;
}

/** Truncates every string attribute in place (REC-8). */
export function truncateAttributes(attrs: Record<string, unknown>): void {
  for (const key in attrs) {
    const v = attrs[key];
    if (typeof v === "string") {
      const cut = truncate(v, key === "exception.stacktrace" ? MAX_STACK_BYTES : MAX_STRING_BYTES);
      if (cut !== v) attrs[key] = cut;
    }
  }
}

/** Attributes in the reserved prefixes an app is allowed to set (spec section 3.1). */
const APP_SETTABLE = new Set(["ouo.exception.fingerprint", "ouo.exception.handled"]);

/** True when an app-supplied name is in a reserved prefix (`session.`, `ouo.`) and not app-settable. */
export function reservedName(name: string): boolean {
  return (name.startsWith("session.") || name.startsWith("ouo.")) && !APP_SETTABLE.has(name);
}

/**
 * Copies the app's attributes that are usable: string, finite number or boolean values, names
 * outside the reserved prefixes, at most {@link MAX_APP_ATTRIBUTES}. `rejected` is called once per
 * dropped attribute so the drop is counted (API-3).
 */
export function appAttributes(input: unknown, rejected: (reason: "reserved_name" | "invalid_attribute") => void): Attrs {
  const out: Attrs = {};
  if (!input || typeof input !== "object") return out;
  let n = 0;
  for (const key of Object.keys(input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>)[key];
    if (reservedName(key)) {
      rejected("reserved_name");
      continue;
    }
    const ok = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
    if (!ok || key === "" || n >= MAX_APP_ATTRIBUTES) {
      rejected("invalid_attribute");
      continue;
    }
    out[key] = v as AttrValue;
    n++;
  }
  return out;
}
