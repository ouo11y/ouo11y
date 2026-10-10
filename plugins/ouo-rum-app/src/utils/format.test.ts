import { formatDuration, formatPct, formatRelative, pct, replaySummary, sessionDurationMs, formatTraceCount } from './format';

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

  it('carries rounded seconds into the minute instead of printing 60s', () => {
    expect(formatDuration(299_600)).toBe('5m 00s');
    expect(formatDuration(3_599_600)).toBe('1h 00m');
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

describe('replaySummary', () => {
  it('is null without a replay', () => {
    expect(replaySummary({ has_replay: false, replay_kind: 'rrweb', replay_duration_ms: 1000 })).toBeNull();
  });

  it('formats the replay length like the Duration column and keeps the kind', () => {
    expect(replaySummary({ has_replay: true, replay_kind: 'frames', replay_duration_ms: 245_000 })).toEqual({
      kind: 'frames',
      duration: '4m 05s',
    });
    expect(replaySummary({ has_replay: true, replay_kind: 'rrweb', replay_duration_ms: 850 })).toEqual({
      kind: 'rrweb',
      duration: '850ms',
    });
  });

  it('reports an unknown length until rum-api ships replay_duration_ms', () => {
    expect(replaySummary({ has_replay: true, replay_kind: 'rrweb' })).toEqual({ kind: 'rrweb', duration: null });
    expect(replaySummary({ has_replay: true, replay_kind: null, replay_duration_ms: null })).toEqual({
      kind: null,
      duration: null,
    });
    expect(replaySummary({ has_replay: true, replay_kind: 'frames', replay_duration_ms: -5 })).toEqual({
      kind: 'frames',
      duration: null,
    });
  });
});
