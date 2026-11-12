/**
 * Replay masking rules (PRV-5, PRV-6), shared by both formats. Everything is masked unless the
 * app unmasks it with `data-ouo-unmask`; `data-ouo-mask` wins over it; password, payment and
 * one-time-code fields are masked whatever the app says. Any doubt fails closed.
 */
export const MASK_ATTR = "data-ouo-mask";
export const UNMASK_ATTR = "data-ouo-unmask";
export const BLOCK_ATTR = "data-ouo-block";
/** What masked text becomes in the structure format. */
export const MASKED_TEXT = "***";

const MEDIA = "img,picture,video,audio,canvas,embed,object";
const UNMASKED = `:is([${UNMASK_ATTR}],[${UNMASK_ATTR}] *):not([${MASK_ATTR}],[${MASK_ATTR}] *)`;
/** Images, video and canvas are blocked unless unmasked; `data-ouo-block` blocks anything. */
export const BLOCK_SELECTOR = `:is(${MEDIA}):not(${UNMASKED}),[${BLOCK_ATTR}],[${BLOCK_ATTR}] *`;

/** Whether text inside `el` is masked. */
export function textMasked(el: Element | null | undefined): boolean {
  try {
    if (!el || typeof el.closest !== "function") return true;
    if (el.closest(`[${MASK_ATTR}]`)) return true;
    return !el.closest(`[${UNMASK_ATTR}]`);
  } catch {
    return true;
  }
}

const SENSITIVE_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/i;
const SENSITIVE_NAME = /passw|pwd|secret|card|ccnum|cvc|cvv|otp|one[-_]?time|pin\b|ssn|iban/i;

/** Password, payment and one-time-code fields: always masked, never unmaskable. */
export function sensitiveField(el: Element | null | undefined): boolean {
  try {
    if (!el) return true;
    const input = el as HTMLInputElement;
    if ((input.type ?? "").toLowerCase() === "password") return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") ?? "")) return true;
    return SENSITIVE_NAME.test(`${el.getAttribute("name") ?? ""} ${el.id ?? ""}`);
  } catch {
    return true;
  }
}

/** Whether the value of a form control is masked. */
export function inputMasked(el: Element | null | undefined): boolean {
  return sensitiveField(el) || textMasked(el);
}

export function blocked(el: Element): boolean {
  try {
    return el.matches(BLOCK_SELECTOR);
  } catch {
    return true;
  }
}

/** Masked text keeps nothing of the original, not even its length; whitespace-only text is layout. */
export function maskText(text: string): string {
  return text.trim() === "" ? text : MASKED_TEXT;
}
