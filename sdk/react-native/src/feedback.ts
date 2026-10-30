import { cutUtf8 } from "./text";
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
