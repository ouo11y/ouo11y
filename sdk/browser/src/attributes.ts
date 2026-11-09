import type { Attrs, AttrValue } from "./types";

/** Signal attribute prefix: `setAttributes({ tenant: "acme" })` sends `ouo.attr.tenant` (docs/specs/attributes.md). */
export const ATTR_PREFIX = "ouo.attr.";
/** Distinct keys across the user and the app sets together. */
export const MAX_ATTRIBUTES = 20;
/** Strings are cut to this many characters. */
export const MAX_VALUE_LENGTH = 128;
/** A letter, then letters, digits and `_` (Loki rewrites `.` and `-` to `_`: no collisions). */
const KEY = /^[A-Za-z]\w{0,39}$/;
const DROPPED = "attribute dropped";

/**
 * Merges the valid entries of `input` into `into` and returns it. `other` is the other set (user or
 * app), counted against the 20-key cap. Invalid entries are dropped and reported with `warn`.
 */
export function mergeAttributes(into: Attrs, input: unknown, other: Attrs, warn: (...args: unknown[]) => void): Attrs {
  if (input && typeof input === "object") {
    for (const [key, raw] of Object.entries(input)) {
      const v: AttrValue | undefined =
        typeof raw === "string" ? raw.slice(0, MAX_VALUE_LENGTH) : typeof raw === "boolean" || Number.isFinite(raw) ? (raw as AttrValue) : undefined;
      if (!KEY.test(key) || v === undefined) warn(DROPPED, key, "invalid");
      else if (!Object.hasOwn(into, key) && !Object.hasOwn(other, key) && new Set([...Object.keys(into), ...Object.keys(other)]).size >= MAX_ATTRIBUTES)
        warn(DROPPED, key, "over 20 keys");
      else into[key] = v;
    }
  }
  return into;
}

/** The `ouo.attr.*` signal attributes of the two sets; the app set wins on a key in both. */
export function signalAttributes(user: Attrs, app: Attrs): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries({ ...user, ...app })) out[ATTR_PREFIX + k] = v;
  return out;
}
