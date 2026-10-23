import type { TimelineEvent, VitalsResponse } from '../api/types';
import {
  formatVitalMs,
  isVitalEvent,
  rateAppStart,
  rateFrames,
  rateStalls,
  rateTtid,
  vitalDetail,
  vitalRating,
  vitalsHeaderItems,
  vitalTitle,
  worstRating,
} from './vitals';

const ev = (name: string, attrs: Record<string, string>): TimelineEvent => ({
  ts: '2026-10-23T10:00:03.316Z',
  type: 'vital',
  name,
  attrs,
});

describe('vital ratings (mobile vitals spec section 4)', () => {
  it('rates app starts by type', () => {
    expect(rateAppStart('cold', 1999)).toBe('good');
    expect(rateAppStart('cold', 2000)).toBe('needs-improvement');
    expect(rateAppStart('cold', 5000)).toBe('poor');
    expect(rateAppStart('warm', 999)).toBe('good');
    expect(rateAppStart('warm', 1000)).toBe('needs-improvement');
    expect(rateAppStart('warm', 2000)).toBe('poor');
    expect(rateAppStart('hot', 10)).toBeUndefined();
  });

  it('rates TTID, frames and stalls', () => {
    expect(rateTtid(999)).toBe('good');
    expect(rateTtid(1000)).toBe('needs-improvement');
    expect(rateTtid(2500)).toBe('poor');
    expect(rateFrames(100, 4, 0)).toBe('good');
    expect(rateFrames(100, 5, 0)).toBe('needs-improvement');
    expect(rateFrames(100, 25, 0)).toBe('poor');
    expect(rateFrames(1000, 0, 1)).toBe('poor');
    expect(rateFrames(0, 0, 0)).toBeUndefined();
    expect(rateStalls(0)).toBe('good');
    expect(rateStalls(999)).toBe('needs-improvement');
    expect(rateStalls(1000)).toBe('poor');
    expect(worstRating(['good', undefined, 'needs-improvement'])).toBe('needs-improvement');
    expect(worstRating([])).toBeUndefined();
  });
});

describe('vital timeline entries (spec section 8)', () => {
  it('titles the four records', () => {
    const start = ev('ouo.app.start', {
      ouo_app_start_type: 'cold',
      ouo_app_start_duration_ms: '3060.7',
      app_screen_name: 'Home',
    });
    expect(vitalTitle(start)).toBe('App start (cold) 3.06 s');
    expect(vitalDetail(start)).toBe('first screen Home');
    expect(vitalRating(start)).toBe('needs-improvement');

    const screen = ev('ouo.screen.display', {
      app_screen_name: 'Home',
      ouo_screen_ttid_ms: '3316.2',
      ouo_screen_ttfd_ms: '3900',
    });
    expect(vitalTitle(screen)).toBe('Home displayed in 3.32 s');
    expect(vitalDetail(screen)).toBe('fully displayed in 3.90 s');
    expect(vitalRating(screen)).toBe('poor');

    const jank = ev('app.jank', {
      app_jank_frame_count: '5',
      ouo_frames_total: '120',
      ouo_frames_slow: '4',
      ouo_frames_frozen: '1',
      ouo_frames_delay_ms: '812.5',
      app_screen_name: 'Home',
      ouo_vital_window: 'screen',
    });
    expect(vitalTitle(jank)).toBe('Janky frames 5 / 120 (1 frozen)');
    expect(vitalDetail(jank)).toBe('Home · 4 slow · 813 ms delay · screen window');
    expect(vitalRating(jank)).toBe('poor');
    // Without app.jank.frame_count: slow + frozen; no "(0 frozen)".
    expect(vitalTitle(ev('app.jank', { ouo_frames_total: '60', ouo_frames_slow: '2', ouo_frames_frozen: '0' }))).toBe(
      'Janky frames 2 / 60'
    );

    const stall = ev('ouo.stall', { ouo_stall_count: '2', ouo_stall_total_ms: '340', ouo_stall_longest_ms: '220' });
    expect(vitalTitle(stall)).toBe('2 JS stalls, longest 220 ms');
    expect(vitalRating(stall)).toBe('needs-improvement');
    expect(vitalTitle(ev('ouo.stall', { ouo_stall_count: '1', ouo_stall_longest_ms: '60' }))).toBe(
      '1 JS stall, longest 60 ms'
    );
  });

  it('recognises vitals typed custom by older rum-api versions', () => {
    expect(isVitalEvent({ type: 'custom', name: 'app.jank' })).toBe(true);
    expect(isVitalEvent({ type: 'web_vital', name: 'web_vital' })).toBe(false);
  });

  it('formats durations', () => {
    expect(formatVitalMs(220.4)).toBe('220 ms');
    expect(formatVitalMs(3060.7)).toBe('3.06 s');
    expect(formatVitalMs(NaN)).toBe('–');
  });
});

describe('vitalsHeaderItems', () => {
  const data: VitalsResponse = {
    session_id: 'V',
    summary: {
      app_start: { type: 'cold', duration_ms: 3060.7, rating: 'needs-improvement' },
      screens: 3,
      ttid_ms: { p50: 410.2, max: 3316.2 },
      frames: { total: 1840, slow: 31, frozen: 1, slow_ratio: 0.0168 },
      stalls: { count: 2, total_ms: 340, longest_ms: 220 },
    },
    vitals: [{ ts: '', name: 'ouo.stall', values: { count: 2 }, rating: 'needs-improvement' }],
  };

  it('builds the compact row', () => {
    expect(vitalsHeaderItems(data)).toEqual([
      { key: 'app_start', label: 'Cold start', value: '3.06 s', rating: 'needs-improvement' },
      { key: 'ttid', label: 'TTID', value: 'p50 410 ms · max 3.32 s', rating: 'good' },
      { key: 'frames', label: 'Frames', value: '31 slow · 1 frozen / 1840', rating: 'poor' },
      { key: 'stalls', label: 'JS stalls', value: '2 · longest 220 ms', rating: 'needs-improvement' },
    ]);
  });

  it('is empty without vitals', () => {
    expect(vitalsHeaderItems(undefined)).toEqual([]);
    expect(vitalsHeaderItems({ session_id: 'x', summary: {}, vitals: [] })).toEqual([]);
  });
});
