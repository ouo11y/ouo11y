import type { Attrs, AttrValue, BundleOptions } from "./types";

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
 * Same rules as the browser SDK's `src/attributes.ts`.
 */
export function mergeAttributes(into: Attrs, input: unknown, other: Attrs, warn: (...args: unknown[]) => void): Attrs {
  if (input && typeof input === "object") {
    for (const [key, raw] of Object.entries(input)) {
      const v: AttrValue | undefined =
        typeof raw === "string" ? raw.slice(0, MAX_VALUE_LENGTH) : typeof raw === "boolean" || Number.isFinite(raw) ? (raw as AttrValue) : undefined;
      if (!KEY.test(key) || v === undefined) warn(DROPPED, key, "invalid");
      else if (!hasOwn(into, key) && !hasOwn(other, key) && new Set([...Object.keys(into), ...Object.keys(other)]).size >= MAX_ATTRIBUTES)
        warn(DROPPED, key, `over ${MAX_ATTRIBUTES} keys`);
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

export const BUNDLE_ID = "ouo.app.bundle.id";
export const BUNDLE_CHANNEL = "ouo.app.bundle.channel";

const text = (v: unknown, max: number): string | undefined => {
  const s = typeof v === "string" ? v.trim() : undefined;
  return s && s.length <= max ? s : undefined;
};

/**
 * `ouo.app.bundle.id` (1 to 128 characters) and `ouo.app.bundle.channel` (1 to 64) of an OTA
 * bundle, or undefined when the id is missing or invalid. An invalid channel is left out.
 */
export function bundleAttributes(bundle: BundleOptions | null | undefined): Attrs | undefined {
  const id = text(bundle?.id, 128);
  if (!id) return undefined;
  const channel = text(bundle?.channel, 64);
  return channel ? { [BUNDLE_ID]: id, [BUNDLE_CHANNEL]: channel } : { [BUNDLE_ID]: id };
}

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}
