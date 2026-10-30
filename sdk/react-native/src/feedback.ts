import type { Attrs, FeedbackInput } from "./types";

/** Longest message and contact kept, in UTF-16 code units (the Sentry bridge cuts at 4096 bytes). */
export const MAX_FEEDBACK_TEXT = 4096;

/**
 * The `feedback` record (docs/specs/mobile-sdk.md C10): the user's text as `ouo.feedback.message`
 * (and the body), the contact when there is one and the id; `initRUM` adds `ouo.feedback.screenshot`.
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

/** Trimmed and cut to MAX_FEEDBACK_TEXT without splitting a surrogate pair; "" for anything but a string. */
function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (s.length <= MAX_FEEDBACK_TEXT) return s;
  const cut = isHighSurrogate(s.charCodeAt(MAX_FEEDBACK_TEXT - 1)) ? MAX_FEEDBACK_TEXT - 1 : MAX_FEEDBACK_TEXT;
  return s.slice(0, cut);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
