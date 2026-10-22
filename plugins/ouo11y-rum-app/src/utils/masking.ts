import type { ReplayMeta } from '../api/types';

export type MaskingState = 'masked' | 'unmasked' | 'unknown';

/**
 * Masking state of a replay (C8) from the replay meta's `masked` flag, which rum-api derives from
 * the chunks: `false` as soon as one chunk was recorded unmasked. No meta or no flag is `unknown`
 * (rrweb replays, older rum-api versions, chunks without the flag).
 */
export function maskingState(meta: Pick<ReplayMeta, 'masked'> | undefined | null): MaskingState {
  if (meta?.masked === true) {
    return 'masked';
  }
  if (meta?.masked === false) {
    return 'unmasked';
  }
  return 'unknown';
}
