import type { Attrs, FeedbackInput } from "./types";

/** Longest message and contact kept, in UTF-8 bytes; the Sentry bridge cuts the same way. */
export const MAX_FEEDBACK_BYTES = 4096;

/**
 * The `feedback` record (docs/specs/mobile-sdk.md C10): the user's text as `ouo.feedback.message`
 * (and the body), the contact when there is one and the id; `initRUM` adds the rest.
 * Undefined when the message is empty: there is nothing to report.
 */
export function feedbackRecord(input: FeedbackInput | undefined, id: string): { body: string; attrs: Attrs } | undefined {
  const message = clean(input?.message);
  if (!message) return undefined;
  const attrs: Attrs = { "ouo.feedback.message": message, "ouo.feedback.id": id };
  const contact = clean(input?.contact);
  if (contact) attrs["ouo.feedback.contact"] = contact;
  return { body: message, attrs };
}

/** Trimmed and cut at MAX_FEEDBACK_BYTES; "" for anything but a string. */
function clean(v: unknown): string {
  return typeof v === "string" ? cutUtf8(v.trim(), MAX_FEEDBACK_BYTES) : "";
}

/**
 * The bridge's cut (Go `truncate`): a string longer than `maxBytes` in UTF-8 keeps its longest
 * prefix of whole code points that fits in `maxBytes`, followed by "…".
 */
export function cutUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) return `${s.slice(0, end)}…`;
    bytes += n;
    end += ch.length;
  }
  return s;
}
