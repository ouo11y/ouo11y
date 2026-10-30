import type { TimelineEvent } from '../api/types';
import { buildFeedback, LAST_EVENTS, parseLastEvents } from './feedback';
import { buildMarkers } from './markers';

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const ev = (ms: number, name: string, attrs: Record<string, string> = {}, type = 'custom'): TimelineEvent => ({
  ts: iso(ms),
  type,
  name,
  attrs,
});

describe('buildFeedback', () => {
  it('reads the record: message, contact, screenshot and its ouo.last_events', () => {
    const last = [
      { ts: T0 + 100, name: 'navigation', body: '/Cart' },
      { ts: T0 + 200, name: 'ui.tap', body: 'Tap pay (button) on Cart' },
    ];
    const [f, ...rest] = buildFeedback([
      ev(0, 'session.start', {}, 'session.start'),
      ev(300, 'feedback', {
        ouo_feedback_message: 'Paying fails',
        ouo_feedback_contact: 'ana@example.com',
        ouo_feedback_screenshot: 'true',
        ouo_last_events: JSON.stringify(last),
      }),
    ]);
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ ts: T0 + 300, message: 'Paying fails', contact: 'ana@example.com', screenshot: true });
    expect(f.steps).toEqual(last);
  });

  it('without ouo.last_events (the bridge): the last LAST_EVENTS timeline events up to it, no feedback among them', () => {
    const timeline = [
      ...Array.from({ length: LAST_EVENTS + 3 }, (_, i) => ev(i * 10, 'ui.tap', { ouo_ui_target: `b${i}` })),
      ev(1000, 'feedback', { ouo_feedback_message: 'first' }),
      ev(2000, 'feedback', { ouo_feedback_message: 'second', ouo_last_events: 'not json' }),
      ev(3000, 'navigation', { url_path: '/Later' }, 'navigation'),
    ];
    const [first, second] = buildFeedback(timeline);
    expect(first.contact).toBeUndefined();
    expect(first.screenshot).toBe(false);
    expect(first.steps).toHaveLength(LAST_EVENTS);
    expect(first.steps[0].event?.attrs.ouo_ui_target).toBe('b3');
    expect(first.steps.at(-1)?.event?.attrs.ouo_ui_target).toBe(`b${LAST_EVENTS + 2}`);
    // Malformed attribute: the timeline instead; the earlier feedback and later events are not steps.
    expect(second.steps.map((s) => s.name)).not.toContain('feedback');
    expect(second.steps.every((s) => s.ts <= T0 + 2000)).toBe(true);
  });

  it('lists a record sent twice (same ouo.feedback.id) once; records without an id are each listed', () => {
    const fb = (ms: number, id?: string) =>
      ev(ms, 'feedback', { ouo_feedback_message: `m${ms}`, ...(id ? { ouo_feedback_id: id } : {}) });
    const got = buildFeedback([fb(100, 'a'), fb(200, 'a'), fb(300), fb(400), fb(500, 'b')]);
    expect(got.map((f) => f.message)).toEqual(['m100', 'm300', 'm400', 'm500']);
  });

  it('a record moved to the session start keeps its own time; one without a message is not listed', () => {
    const moved = { ...ev(0, 'feedback', { ouo_feedback_message: 'early' }), clampedFrom: iso(-500) };
    expect(buildFeedback([moved, ev(10, 'feedback', {})]).map((f) => [f.message, f.ts])).toEqual([['early', T0 - 500]]);
  });
});

describe('parseLastEvents', () => {
  it('keeps well-formed entries only', () => {
    expect(
      parseLastEvents(
        JSON.stringify([{ ts: 1, name: 'log' }, { ts: 'x', name: 'y' }, null, { ts: 2, name: 'ui.tap', body: 'Tap' }])
      )
    ).toEqual([
      { ts: 1, name: 'log', body: '' },
      { ts: 2, name: 'ui.tap', body: 'Tap' },
    ]);
    expect(parseLastEvents(undefined)).toBeUndefined();
    expect(parseLastEvents('{"a":1}')).toBeUndefined();
    expect(parseLastEvents('[')).toBeUndefined();
  });
});

describe('feedback marker', () => {
  it('a feedback is a marker on the replay bar', () => {
    const m = buildMarkers([ev(500, 'feedback', { ouo_feedback_message: 'slow' })], T0, 1000);
    expect(m).toMatchObject([{ kind: 'feedback', label: 'Feedback: slow', leftPct: 50 }]);
  });
});
