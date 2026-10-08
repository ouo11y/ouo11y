import { formatDuration, formatPct, formatRelative, pct, sessionDurationMs, formatTraceCount } from './format';

describe('formatPct', () => {
  it('matches rum-api rounding to two decimals', () => {
    expect(formatPct(33.33)).toBe('33.33%');
    expect(formatPct(66.67)).toBe('66.67%');
    expect(formatPct(100)).toBe('100%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(12.5)).toBe('12.5%');
    expect(formatPct(undefined)).toBe('–');
  });
});

describe('pct', () => {
  it('computes rum-api style percentages', () => {
    expect(pct(3, 9)).toBe(33.33);
    expect(pct(6, 9)).toBe(66.67);
    expect(pct(0, 0)).toBe(0);
    expect(pct(2, 4)).toBe(50);
  });
});

describe('formatDuration', () => {
  it('scales units', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(245_000)).toBe('4m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
    expect(formatDuration(-1)).toBe('–');
  });
});

describe('formatRelative', () => {
  it('prefixes a sign and keeps one decimal under a minute', () => {
    expect(formatRelative(0)).toBe('+0.0s');
    expect(formatRelative(12_300)).toBe('+12.3s');
    expect(formatRelative(-1500)).toBe('-1.5s');
    expect(formatRelative(125_000)).toBe('+2m 05s');
  });
});

describe('sessionDurationMs', () => {
  it('uses ended_at when present, last_signal_at otherwise', () => {
    expect(
      sessionDurationMs({
        started_at: '2026-10-06T05:06:20.000Z',
        ended_at: '2026-10-06T05:07:20.000Z',
        last_signal_at: '2026-10-06T05:06:40.000Z',
      })
    ).toBe(60_000);
    expect(
      sessionDurationMs({
        started_at: '2026-10-06T05:06:20.000Z',
        ended_at: null,
        last_signal_at: '2026-10-06T05:06:40.000Z',
      })
    ).toBe(20_000);
  });
});

describe('formatTraceCount', () => {
  it('shows n/a when Tempo failed', () => {
    expect(formatTraceCount(-1)).toBe('n/a');
    expect(formatTraceCount(22)).toBe('22');
  });
});
