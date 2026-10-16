import type { TimelineEvent } from '../api/types';
import { activeActivityIndex, buildActivity, matchesFilter } from './activity';

const start = 1_791_946_506_794;
const ev = (offsetMs: number, type: string, name = type, attrs: Record<string, string> = {}): TimelineEvent => ({
  ts: new Date(start + offsetMs).toISOString(),
  type,
  name,
  attrs,
});

describe('buildActivity', () => {
  const timeline = [
    ev(0, 'session.start'),
    ev(1000, 'navigation'),
    ev(2000, 'custom', 'ui.tap', { ouo_ui_target: 'btn' }),
    ev(3000, 'custom', 'http.request'),
    ev(4000, 'http.request.failed'),
    ev(5000, 'custom', 'log', { ouo_sentry_level: 'error' }),
    ev(6000, 'exception'),
  ];

  it('lists the timeline in order with categories', () => {
    const items = buildActivity(timeline, start);
    expect(items.map((i) => [i.category, i.offsetMs, i.isError])).toEqual([
      ['other', 0, false],
      ['navigation', 1000, false],
      ['tap', 2000, false],
      ['network', 3000, false],
      ['network', 4000, true],
      ['log', 5000, true],
      ['error', 6000, true],
    ]);
  });

  it('replaces ui.tap events by the merged taps', () => {
    const items = buildActivity(timeline, start, [
      { ts: start + 1990, x: 1, y: 2, target: 'btn', timelineIndex: 2 },
      { ts: start + 3500, x: 5, y: 6 },
    ]);
    const taps = items.filter((i) => i.category === 'tap');
    expect(taps.map((t) => [t.offsetMs, t.tap?.target])).toEqual([
      [1990, 'btn'],
      [3500, undefined],
    ]);
    expect(items.filter((i) => i.event?.name === 'ui.tap')).toEqual([]);
    expect(items.filter((i) => matchesFilter(i, 'error'))).toHaveLength(3);
  });
});

describe('activeActivityIndex', () => {
  it('finds the latest item at or before the cursor', () => {
    const items = buildActivity([ev(1000, 'navigation'), ev(2000, 'navigation')], start);
    expect(activeActivityIndex(items, 500)).toBe(-1);
    expect(activeActivityIndex(items, 1000)).toBe(0);
    expect(activeActivityIndex(items, 5000)).toBe(1);
  });
});
