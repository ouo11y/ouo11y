import { maskingState } from './masking';

describe('maskingState (C8)', () => {
  it('follows the replay meta masked flag', () => {
    expect(maskingState({ masked: true })).toBe('masked');
    expect(maskingState({ masked: false })).toBe('unmasked');
  });

  it('is unknown without a meta or a flag (rrweb, older rum-api, chunks without the flag)', () => {
    expect(maskingState(undefined)).toBe('unknown');
    expect(maskingState(null)).toBe('unknown');
    expect(maskingState({})).toBe('unknown');
  });
});
