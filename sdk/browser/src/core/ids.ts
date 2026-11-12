/**
 * Identifiers and the sampling rule (SES-1, SMP-2, SMP-8). Pure, shared by every tab: the
 * decision is a function of the id, so tabs agree without talking.
 */

const HEX = "0123456789abcdef";

/** Whether the platform has a cryptographically secure generator. Without one the SDK stays off. */
export function hasSecureRandom(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function";
}

/** `bytes` random bytes as lowercase hex (16 bytes: a 128-bit session, replay or stream id). */
export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (let i = 0; i < buf.length; i++) out += HEX[buf[i]! >> 4]! + HEX[buf[i]! & 15]!;
  return out;
}

export const newSessionId = (): string => randomHex(16);
/** A view is one visit to one page: 64 bits are plenty inside a session. */
export const newViewId = (): string => randomHex(8);

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/**
 * Sampled when the 8 hex characters at `offset`, read as an unsigned 32-bit integer and divided
 * by 2^32, are below `rate`. Offset 0 is the session decision (SMP-2), offset 8 the replay
 * decision (SMP-8), so the two are independent.
 */
export function sampledAt(id: string, rate: number, offset: 0 | 8): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return fractionAt(id, offset) < rate;
}

/** The 8 hex characters at `offset` as a number in [0, 1). */
export function fractionAt(id: string, offset: 0 | 8): number {
  return parseInt(id.slice(offset, offset + 8), 16) / 0x1_0000_0000;
}
