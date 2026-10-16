import type { TimelineEvent } from '../api/types';
import { buildMarkers, latestEventIndex, markerPosition, replayBounds, seekOffset } from './markers';

const start = Date.parse('2026-10-06T05:06:20.000Z');
const ev = (offsetMs: number, type: string, attrs: Record<string, string> = {}): TimelineEvent => ({
  ts: new Date(start + offsetMs).toISOString(),
  type,
  name: type,
  attrs,
});

describe('markerPosition', () => {
  it('maps an instant to 0..100 percent of the replay', () => {
    expect(markerPosition(start, start, 10_000)).toBe(0);
    expect(markerPosition(start + 2_500, start, 10_000)).toBe(25);
    expect(markerPosition(start + 10_000, start, 10_000)).toBe(100);
  });
  it('clamps events outside the replay window', () => {
    expect(markerPosition(start - 500, start, 10_000)).toBe(0);
    expect(markerPosition(start + 20_000, start, 10_000)).toBe(100);
  });
  it('is 0 for a zero or invalid duration', () => {
    expect(markerPosition(start + 5, start, 0)).toBe(0);
    expect(markerPosition(NaN, start, 10)).toBe(0);
  });
});

describe('seekOffset', () => {
  it('never seeks before the start or past the end', () => {
    expect(seekOffset(start - 100, start, 10_000)).toBe(0);
    expect(seekOffset(start + 4_000, start, 10_000)).toBe(4_000);
    expect(seekOffset(start + 40_000, start, 10_000)).toBe(10_000);
  });
});

describe('buildMarkers', () => {
  it('keeps errors, crashes, failed requests and navigations with positions', () => {
    const timeline = [
      ev(0, 'session.start'),
      ev(1_000, 'navigation', { url_path: '/' }),
      ev(2_000, 'web_vital', { ouo_web_vital_name: 'LCP' }),
      ev(5_000, 'exception', { ouo_exception_fatal: 'false', exception_type: 'Error', exception_message: 'handled' }),
      ev(7_500, 'http.request.failed', {
        http_request_method: 'POST',
        url_full: 'http://x/api/checkout',
        http_response_status_code: '500',
      }),
      ev(10_000, 'exception', { ouo_exception_fatal: 'true', exception_type: 'Error', exception_message: 'boom' }),
      ev(11_000, 'custom'),
    ];
    const markers = buildMarkers(timeline, start, 10_000);
    expect(markers.map((m) => [m.index, m.kind, m.leftPct])).toEqual([
      [1, 'navigation', 10],
      [3, 'error', 50],
      [4, 'failed_request', 75],
      [5, 'crash', 100],
    ]);
    expect(markers[1].label).toBe('Error: Error handled');
    expect(markers[2].label).toBe('POST http://x/api/checkout → 500');
    expect(markers[3].offsetMs).toBe(10_000);
  });
});

describe('latestEventIndex', () => {
  const timeline = [ev(0, 'session.start'), ev(1_000, 'navigation'), ev(5_000, 'exception'), ev(9_000, 'session.end')];
  it('returns the latest event at or before the replay cursor', () => {
    expect(latestEventIndex(timeline, start, 0)).toBe(0);
    expect(latestEventIndex(timeline, start, 999)).toBe(0);
    expect(latestEventIndex(timeline, start, 1_000)).toBe(1);
    expect(latestEventIndex(timeline, start, 6_000)).toBe(2);
    expect(latestEventIndex(timeline, start, 60_000)).toBe(3);
  });
  it('is -1 before the first event', () => {
    expect(latestEventIndex(timeline, start + 10_000, 0)).toBe(3);
    expect(latestEventIndex(timeline, start - 10_000, 0)).toBe(-1);
  });
});

describe('replayBounds', () => {
  it('uses first and last rrweb event timestamps', () => {
    expect(replayBounds([{ timestamp: 100 }, { timestamp: 250 }, { timestamp: 900 }])).toEqual({
      start: 100,
      durationMs: 800,
    });
    expect(replayBounds([])).toEqual({ start: NaN, durationMs: 0 });
  });
});

describe('tap markers', () => {
  const tap = (offsetMs: number, target: string): TimelineEvent => ({
    ts: new Date(start + offsetMs).toISOString(),
    type: 'custom',
    name: 'ui.tap',
    attrs: { ouo_ui_target: target },
  });

  it('marks ui.tap events, under the other kinds', () => {
    const markers = buildMarkers([ev(1_000, 'navigation'), tap(2_000, 'btn-Pay')], start, 10_000);
    expect(markers.map((m) => [m.kind, m.leftPct, m.label])).toEqual([
      ['tap', 20, 'Tap btn-Pay'],
      ['navigation', 10, 'Navigation'],
    ]);
  });

  it('takes taps from the merged list when one is given, including touches without a breadcrumb', () => {
    const markers = buildMarkers([tap(2_000, 'btn-Pay')], start, 10_000, [
      { ts: start + 1_950, x: 1, y: 1, target: 'btn-Pay', timelineIndex: 0 },
      { ts: start + 5_000, x: 10, y: 20 },
    ]);
    expect(markers.map((m) => [m.kind, m.index, m.offsetMs, m.label])).toEqual([
      ['tap', 0, 1_950, 'Tap btn-Pay'],
      ['tap', -1, 5_000, 'Tap at 10, 20'],
    ]);
    expect(new Set(markers.map((m) => m.key)).size).toBe(2);
  });
});
