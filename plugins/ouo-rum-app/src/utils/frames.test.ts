import type { ReplayFramesResponse, ReplayTouch } from '../api/types';
import fixture from '../__fixtures__/frames.json';
import {
  clampOffset,
  frameIndexAt,
  framesBounds,
  replayRenderer,
  stepFrameIndex,
  TOUCH_WINDOW_MS,
  visibleTouches,
} from './frames';

const resp = fixture as ReplayFramesResponse;
const start = resp.started_at;

describe('fixture', () => {
  it('is a frames replay with sorted frames and decodable JPEGs', () => {
    expect(resp.kind).toBe('frames');
    expect(resp.frames.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < resp.frames.length; i++) {
      expect(resp.frames[i].ts).toBeGreaterThan(resp.frames[i - 1].ts);
    }
    for (const f of resp.frames) {
      const bytes = Buffer.from(f.jpeg, 'base64');
      expect(bytes[0]).toBe(0xff); // SOI marker
      expect(bytes[1]).toBe(0xd8);
    }
  });
});

describe('frameIndexAt', () => {
  const frames = resp.frames; // offsets 0, 1000, 2300, 4000, 6000
  it('picks the latest frame at or before the instant', () => {
    expect(frameIndexAt(frames, start)).toBe(0);
    expect(frameIndexAt(frames, start + 999)).toBe(0);
    expect(frameIndexAt(frames, start + 1000)).toBe(1);
    expect(frameIndexAt(frames, start + 2299)).toBe(1);
    expect(frameIndexAt(frames, start + 2300)).toBe(2);
    expect(frameIndexAt(frames, start + 5999)).toBe(3);
  });
  it('shows the first frame before the first ts and the last after the last ts', () => {
    expect(frameIndexAt(frames, start - 10_000)).toBe(0);
    expect(frameIndexAt(frames, start + 6000)).toBe(4);
    expect(frameIndexAt(frames, start + 60_000)).toBe(4);
  });
  it('handles empty input and NaN', () => {
    expect(frameIndexAt([], start)).toBe(-1);
    expect(frameIndexAt(frames, NaN)).toBe(0);
  });
});

describe('visibleTouches', () => {
  const viewport = { width: 393, height: 852 };
  const touches: ReplayTouch[] = [
    { ts: start + 1000, x: 196.5, y: 426, phase: 'began' },
    { ts: start + 1400, x: 393, y: 852, phase: 'ended' },
    { ts: start + 3000, x: 500, y: 10, phase: 'began' }, // outside the viewport
  ];
  it('shows touches within the last 500 ms with a linear fade', () => {
    expect(visibleTouches(touches, viewport, start + 999)).toEqual([]);
    const atTouch = visibleTouches(touches, viewport, start + 1000);
    expect(atTouch).toHaveLength(1);
    expect(atTouch[0].left).toBeCloseTo(0.5);
    expect(atTouch[0].top).toBeCloseTo(0.5);
    expect(atTouch[0].opacity).toBe(1);
    const half = visibleTouches(touches, viewport, start + 1250);
    expect(half[0].opacity).toBeCloseTo(0.5);
    expect(visibleTouches(touches, viewport, start + 1500)).toHaveLength(2); // first at 0 opacity edge, second at 0.8
    expect(visibleTouches(touches, viewport, start + 1500)[0].opacity).toBeCloseTo(0);
    expect(visibleTouches(touches, viewport, start + 1501)).toHaveLength(1);
    expect(TOUCH_WINDOW_MS).toBe(500);
  });
  it('accepts a custom window and drops out-of-viewport touches', () => {
    expect(visibleTouches(touches, viewport, start + 1800, 1000)).toHaveLength(2);
    expect(visibleTouches(touches, viewport, start + 3000)).toEqual([]);
    expect(visibleTouches(touches, { width: 0, height: 0 }, start + 1000)).toEqual([]);
  });
});

describe('framesBounds', () => {
  it('uses started_at / ended_at of the response', () => {
    expect(framesBounds(resp)).toEqual({ start, durationMs: 7000 });
  });
  it('falls back to the frames when bounds are missing and is empty without a response', () => {
    const noBounds = { started_at: NaN, ended_at: NaN, frames: resp.frames };
    expect(framesBounds(noBounds)).toEqual({ start, durationMs: 6000 });
    expect(framesBounds(undefined)).toEqual({ start: NaN, durationMs: 0 });
    expect(framesBounds({ started_at: NaN, ended_at: NaN, frames: [] })).toEqual({ start: NaN, durationMs: 0 });
  });
});

describe('clampOffset', () => {
  it('keeps the scrubber inside [0, duration]', () => {
    expect(clampOffset(-5, 7000)).toBe(0);
    expect(clampOffset(3500, 7000)).toBe(3500);
    expect(clampOffset(9000, 7000)).toBe(7000);
    expect(clampOffset(NaN, 7000)).toBe(0);
    expect(clampOffset(100, 0)).toBe(0);
  });
});

describe('replayRenderer', () => {
  it('prefers replay_kind on the record', () => {
    expect(replayRenderer({ has_replay: true, replay_kind: 'frames' }, undefined)).toBe('frames');
    expect(replayRenderer({ has_replay: true, replay_kind: 'rrweb' }, undefined)).toBe('rrweb');
  });
  it('falls back to the replay meta kind, rrweb when the meta has none', () => {
    expect(replayRenderer({ has_replay: true, replay_kind: null }, undefined)).toBeUndefined();
    expect(replayRenderer({ has_replay: true }, { kind: 'frames' })).toBe('frames');
    expect(replayRenderer({ has_replay: true }, { kind: 'rrweb' })).toBe('rrweb');
    expect(replayRenderer({ has_replay: true }, {})).toBe('rrweb');
  });
  it('is null without a replay and undefined without a session', () => {
    expect(replayRenderer({ has_replay: false, replay_kind: 'frames' }, undefined)).toBeNull();
    expect(replayRenderer(undefined, undefined)).toBeUndefined();
  });
});

describe('stepFrameIndex', () => {
  it('clamps at both ends', () => {
    expect(stepFrameIndex(5, 0, -1)).toBe(0);
    expect(stepFrameIndex(5, 2, 1)).toBe(3);
    expect(stepFrameIndex(5, 4, 1)).toBe(4);
    expect(stepFrameIndex(0, 0, 1)).toBe(-1);
  });
});
