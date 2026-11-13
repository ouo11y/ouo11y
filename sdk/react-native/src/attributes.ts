import type { DropCounter } from "./drops";
import { cutUtf8 } from "./text";
import type { Attrs, AttrValue } from "./types";

/** Spec REC-8: `exception.stacktrace` is cut to 25 KiB (the top frames are kept), other strings to 4 KiB. */
export const MAX_STACKTRACE_BYTES = 25 * 1024;
export const MAX_STRING_BYTES = 4 * 1024;
/** Spec REC-8: all attributes of one record stay under 64 KB (the Loki metadata limit). */
export const MAX_RECORD_ATTRIBUTE_BYTES = 64 * 1000;

/**
 * Attributes whose value is a JSON document the consumers parse (symbolication, the last-events
 * list): cutting one at 4 KiB would leave unreadable JSON, so they are bounded where they are
 * built and here only by the record total.
 */
const STRUCTURED = new Set(["ouo.crash.frames", "ouo.crash.images", "ouo.last_events"]);

/** Reserved prefixes (spec API-3): names the app may not set, and the ones it may. */
const RESERVED_PREFIXES = ["session.", "ouo."];
const APP_SETTABLE = new Set(["ouo.exception.fingerprint"]);

export function isReservedName(name: string, allowed: ReadonlySet<string> = APP_SETTABLE): boolean {
  if (allowed.has(name) || APP_SETTABLE.has(name)) return false;
  return RESERVED_PREFIXES.some((p) => name.startsWith(p));
}

/** A plain map of finite primitives out of anything: null, arrays, nested or cyclic objects and NaN are left out. Never throws. */
export function primitiveAttributes(input: unknown): Attrs {
  const out: Attrs = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  try {
    for (const key of Object.keys(input)) {
      const value = (input as Record<string, unknown>)[key];
      const type = typeof value;
      if (type === "string" || type === "boolean" || (type === "number" && Number.isFinite(value))) out[key] = value as AttrValue;
    }
  } catch {
    // a throwing getter or proxy: what was read so far
  }
  return out;
}

/**
 * App-supplied attributes as the SDK records them: primitives only, and keys in a reserved
 * prefix are dropped and counted (API-3), except those in `allowed`.
 */
export function appAttributes(input: unknown, drops: DropCounter | undefined, allowed?: ReadonlySet<string>): Attrs {
  const out = primitiveAttributes(input);
  for (const key of Object.keys(out)) {
    if (!isReservedName(key, allowed)) continue;
    delete out[key];
    drops?.count("attribute", "reserved_name");
  }
  return out;
}

/** UTF-8 length, counted only when the string could be over `max`. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
  }
  return n;
}

/** `s` cut to `max` UTF-8 bytes (plus "…"); strings that cannot be longer are returned untouched. */
function cut(s: string, max: number): string {
  return s.length * 3 <= max ? s : cutUtf8(s, max);
}

/**
 * Truncation at source (REC-8), in place on a record's attribute map: each string is cut, then
 * the largest attributes are removed until the record is under the total. Returns the names
 * removed for the total (for the debug log; never the values).
 */
export function truncateAttributes(attributes: Record<string, unknown>): string[] {
  const sizes: Array<[string, number]> = [];
  let total = 0;
  for (const key of Object.keys(attributes)) {
    let value = attributes[key];
    if (typeof value === "string") {
      if (key === "exception.stacktrace") value = cut(value, MAX_STACKTRACE_BYTES);
      else if (!STRUCTURED.has(key)) value = cut(value, MAX_STRING_BYTES);
      attributes[key] = value;
    }
    const size = key.length + (typeof value === "string" ? (value.length * 3 <= MAX_STRING_BYTES ? value.length : utf8Length(value)) : 8);
    sizes.push([key, size]);
    total += size;
  }
  if (total <= MAX_RECORD_ATTRIBUTE_BYTES) return [];
  const removed: string[] = [];
  sizes.sort((a, b) => b[1] - a[1]);
  for (const [key, size] of sizes) {
    if (total <= MAX_RECORD_ATTRIBUTE_BYTES) break;
    delete attributes[key];
    removed.push(key);
    total -= size;
  }
  return removed;
}
