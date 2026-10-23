/**
 * Shared sampling rule of the ouo SDKs and rum-api (roadmap 8b): a deterministic function of the
 * session id, so the browser, React Native and a server-side per-project cap lower than the
 * client's rate all keep the same consistent subset of sessions.
 *
 *   sampled(id, rate, salt) = fmix32(fnv1a32(salt + ":" + id)) / 2^32 < rate
 *
 * FNV-1a 32 over UTF-16 code units, then MurmurHash3's fmix32 finalizer so the decisions of one
 * id under different salts ("session", "replay", "replay_on_error") are independent.
 * Go reference: services/rum-api/internal/sampling.
 */
export function samplingHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export type SamplingSalt = "session" | "replay" | "replay_on_error";

export function isSampled(sessionId: string, rate: number, salt: SamplingSalt): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return samplingHash(`${salt}:${sessionId}`) / 2 ** 32 < rate;
}
