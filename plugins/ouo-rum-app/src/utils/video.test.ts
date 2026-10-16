import { videoSegmentUrl } from '../api/client';
import { VIDEO_START as S, videoManifest } from '../__fixtures__/video';
import { visibleTouches } from './frames';
import {
  DRIFT_SEC,
  frameStepMs,
  locateSegment,
  type MediaLike,
  mediaErrorText,
  mediaPending,
  mediaTimeSec,
  mountedSegmentIndices,
  orderSegments,
  segmentDurationMs,
  segmentStartOffset,
  syncMediaElement,
  totalFrames,
  videoBounds,
} from './video';

const segs = videoManifest.segments;

describe('locateSegment (global time -> segment, offset)', () => {
  it('maps an instant inside a segment to that segment and the offset into it', () => {
    expect(locateSegment(segs, S)).toEqual({ index: 0, offsetMs: 0, inGap: false });
    expect(locateSegment(segs, S + 2300)).toEqual({ index: 0, offsetMs: 2300, inGap: false });
    expect(locateSegment(segs, S + 7250)).toEqual({ index: 1, offsetMs: 2250, inGap: false });
    expect(locateSegment(segs, S + 16_999)).toEqual({ index: 2, offsetMs: 4999, inGap: false });
  });

  it('hands over to the next segment exactly at its start', () => {
    expect(locateSegment(segs, S + 4999)).toEqual({ index: 0, offsetMs: 4999, inGap: false });
    expect(locateSegment(segs, S + 5000)).toEqual({ index: 1, offsetMs: 0, inGap: false });
  });

  it('keeps the previous segment (last frame) in a gap and after the end', () => {
    expect(locateSegment(segs, S + 10_000)).toEqual({ index: 1, offsetMs: 5000, inGap: true });
    expect(locateSegment(segs, S + 11_500)).toEqual({ index: 1, offsetMs: 6500, inGap: true });
    expect(locateSegment(segs, S + 12_000)).toEqual({ index: 2, offsetMs: 0, inGap: false });
    expect(locateSegment(segs, S + 20_000)).toEqual({ index: 2, offsetMs: 8000, inGap: true });
  });

  it('shows the first frame before the first segment and handles empty or invalid input', () => {
    expect(locateSegment(segs, S - 1000)).toEqual({ index: 0, offsetMs: 0, inGap: true });
    expect(locateSegment(segs, NaN)).toEqual({ index: 0, offsetMs: 0, inGap: true });
    expect(locateSegment([], S)).toEqual({ index: -1, offsetMs: 0, inGap: true });
  });

  it('uses ended_at - started_at when duration_ms is missing', () => {
    const noDur = [{ started_at: 0, ended_at: 3000, duration_ms: 0 }];
    expect(segmentDurationMs(noDur[0])).toBe(3000);
    expect(locateSegment(noDur, 2999).inGap).toBe(false);
    expect(locateSegment(noDur, 3000).inGap).toBe(true);
  });
});

describe('segment helpers', () => {
  it('orders segments by seq without mutating the input', () => {
    const shuffled = [segs[2], segs[0], segs[1]];
    expect(orderSegments(shuffled).map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(shuffled[0].seq).toBe(2);
    expect(orderSegments(undefined)).toEqual([]);
  });

  it('gives the global offset of a segment start for stepping and markers', () => {
    expect(segmentStartOffset(segs[2], S)).toBe(12_000);
    expect(segmentStartOffset(segs[0], S + 100)).toBe(0);
  });

  it('mounts the active segment and preloads the next one', () => {
    expect(mountedSegmentIndices(3, 0)).toEqual([0, 1]);
    expect(mountedSegmentIndices(3, 1)).toEqual([1, 2]);
    expect(mountedSegmentIndices(3, 2)).toEqual([2]);
    expect(mountedSegmentIndices(0, 0)).toEqual([]);
    expect(mountedSegmentIndices(3, -1)).toEqual([]);
  });

  it('converts a segment offset to currentTime, clamped short of the decoded end', () => {
    expect(mediaTimeSec(2500, NaN)).toBe(2.5);
    expect(mediaTimeSec(2500, 5)).toBe(2.5);
    expect(mediaTimeSec(6500, 4.8)).toBeCloseTo(4.799, 6);
    expect(mediaTimeSec(-10, 5)).toBe(0);
    expect(mediaTimeSec(NaN, 5)).toBe(0);
  });

  it('derives the replay bounds from the manifest, falling back to the segments', () => {
    expect(videoBounds(videoManifest)).toEqual({ start: S, durationMs: 17_000 });
    expect(videoBounds({ ...videoManifest, started_at: NaN, ended_at: NaN })).toEqual({ start: S, durationMs: 17_000 });
    expect(videoBounds(undefined)).toEqual({ start: NaN, durationMs: 0 });
    expect(videoBounds({ started_at: NaN, ended_at: NaN, segments: [] })).toEqual({ start: NaN, durationMs: 0 });
  });

  it('counts frames and steps one encoded frame', () => {
    expect(totalFrames(segs)).toBe(15);
    expect(frameStepMs(segs[0])).toBe(1000);
    expect(frameStepMs({ ...segs[0], frame_count: 0 })).toBe(1000);
    expect(frameStepMs({ ...segs[0], frame_count: 500 })).toBe(100);
    expect(frameStepMs(undefined)).toBe(1000);
  });

  it('maps manifest paths onto the plugin proxy route', () => {
    expect(videoSegmentUrl('sess-video', segs[1])).toBe(
      '/api/plugin-proxy/ouo-rum-app/rum/v1/sessions/sess-video/replay/video/1'
    );
    expect(videoSegmentUrl('a b', { seq: 4, path: '' })).toBe(
      '/api/plugin-proxy/ouo-rum-app/rum/v1/sessions/a%20b/replay/video/4'
    );
    expect(videoSegmentUrl('x', { seq: 0, path: 'http://evil.example/x' })).toBe(
      '/api/plugin-proxy/ouo-rum-app/rum/v1/sessions/x/replay/video/0'
    );
  });
});

describe('touch scaling (video pixel space -> rendered stage)', () => {
  const viewport = videoManifest.viewport;

  it('normalises x/y by the video size so the overlay scales with the rendered stage', () => {
    const [t] = visibleTouches(videoManifest.touches, viewport, S + 2000);
    expect(t.left).toBeCloseTo(0.5);
    expect(t.top).toBeCloseTo(0.5);
    // A stage rendered at 70vh of a 900px window: 630px tall, 630 * 288/624 wide.
    const renderedH = 630;
    const renderedW = renderedH * (viewport.width / viewport.height);
    expect(t.left * renderedW).toBeCloseTo(renderedW / 2);
    expect(t.top * renderedH).toBeCloseTo(315);
    const [corner] = visibleTouches([{ ts: 0, x: 72, y: 600, phase: 'ended' }], viewport, 0);
    expect(corner.left * 144).toBeCloseTo(36); // 72px of 288 is a quarter of any rendered width
    expect(corner.top).toBeCloseTo(600 / 624);
  });

  it('fades each touch out over 500 ms', () => {
    expect(visibleTouches(videoManifest.touches, viewport, S + 1999)).toHaveLength(0);
    expect(visibleTouches(videoManifest.touches, viewport, S + 2250)[0].opacity).toBeCloseTo(0.5);
    expect(visibleTouches(videoManifest.touches, viewport, S + 2500)[0].opacity).toBeCloseTo(0);
    expect(visibleTouches(videoManifest.touches, viewport, S + 2501)).toHaveLength(0);
  });
});

function fakeMedia(over: Partial<MediaLike> = {}) {
  const el = {
    currentTime: 0,
    duration: 5,
    paused: true,
    ended: false,
    seeking: false,
    readyState: 4,
    error: null,
    playbackRate: 1,
    play: jest.fn(() => {
      el.paused = false;
      return Promise.resolve();
    }),
    pause: jest.fn(() => {
      el.paused = true;
    }),
    ...over,
  };
  return el as { -readonly [K in keyof MediaLike]: MediaLike[K] } & {
    play: jest.Mock;
    pause: jest.Mock;
  };
}

describe('syncMediaElement', () => {
  it('seeks and plays at the clock speed inside a segment', () => {
    const el = fakeMedia();
    syncMediaElement(el, { index: 0, offsetMs: 2000, inGap: false }, true, 2);
    expect(el.currentTime).toBe(2);
    expect(el.playbackRate).toBe(2);
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it('lets a playing element run on its own clock within the drift tolerance', () => {
    const el = fakeMedia({ paused: false, currentTime: 2.1 });
    syncMediaElement(el, { index: 0, offsetMs: 2000 + (DRIFT_SEC * 1000) / 2, inGap: false }, true, 1);
    expect(el.currentTime).toBe(2.1);
    syncMediaElement(el, { index: 0, offsetMs: 3000, inGap: false }, true, 1);
    expect(el.currentTime).toBe(3);
    expect(el.play).not.toHaveBeenCalled();
  });

  it('pauses on the last frame in a gap and on the exact frame while paused', () => {
    const el = fakeMedia({ paused: false, currentTime: 4.9 });
    syncMediaElement(el, { index: 1, offsetMs: 6500, inGap: true }, true, 1);
    expect(el.pause).toHaveBeenCalled();
    expect(el.currentTime).toBeCloseTo(4.999);
    const still = fakeMedia({ currentTime: 1 });
    syncMediaElement(still, { index: 0, offsetMs: 1500, inGap: false }, false, 1);
    expect(still.currentTime).toBe(1.5);
    expect(still.play).not.toHaveBeenCalled();
  });

  it('does not restart an ended segment, seek while seeking, or play a broken one', () => {
    const ended = fakeMedia({ ended: true, currentTime: 5 });
    syncMediaElement(ended, { index: 0, offsetMs: 4999.5, inGap: false }, true, 1);
    expect(ended.play).not.toHaveBeenCalled();
    const seeking = fakeMedia({ seeking: true, currentTime: 1 });
    syncMediaElement(seeking, { index: 0, offsetMs: 3000, inGap: false }, false, 1);
    expect(seeking.currentTime).toBe(1);
    const broken = fakeMedia({ error: { code: 3 } });
    syncMediaElement(broken, { index: 0, offsetMs: 1000, inGap: false }, true, 1);
    expect(broken.play).not.toHaveBeenCalled();
  });

  it('swallows a rejected play() (autoplay policy, aborted load)', async () => {
    const el = fakeMedia({ play: jest.fn(() => Promise.reject(new Error('NotAllowedError'))) });
    expect(() => syncMediaElement(el, { index: 0, offsetMs: 0, inGap: false }, true, 1)).not.toThrow();
    await Promise.resolve();
  });

  it('reports a pending segment only while it has no frame and no error', () => {
    const pos = { index: 0, offsetMs: 0, inGap: false };
    expect(mediaPending(fakeMedia({ readyState: 1 }), pos)).toBe(true);
    expect(mediaPending(fakeMedia({ readyState: 2 }), pos)).toBe(false);
    expect(mediaPending(fakeMedia({ readyState: 0, error: { code: 4 } }), pos)).toBe(false);
    expect(mediaPending(fakeMedia({ readyState: 0 }), { ...pos, inGap: true })).toBe(false);
    expect(mediaPending(undefined, pos)).toBe(false);
  });

  it('describes media errors', () => {
    expect(mediaErrorText({ code: 4 })).toMatch(/not a playable mp4/);
    expect(mediaErrorText({ code: 3 })).toMatch(/decoded/);
    expect(mediaErrorText(null)).toBe('unknown media error');
  });
});
