import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VIDEO_START, videoManifest } from '../__fixtures__/video';
import type { ReplayHandle } from './ReplayPlayer';
import { VideoPlayer } from './VideoPlayer';

const durationMs = videoManifest.ended_at - videoManifest.started_at;

function renderPlayer(onTime = jest.fn(), manifest = videoManifest) {
  const ref = React.createRef<ReplayHandle>();
  const utils = render(
    <VideoPlayer
      ref={ref}
      manifest={manifest}
      startTs={VIDEO_START}
      durationMs={durationMs}
      onTime={onTime}
      segmentUrl={(s) => `/proxy/seg/${s.seq}`}
    />
  );
  return { ref, onTime, ...utils };
}

const stage = () => screen.getByTestId('video-stage');
const segmentIndex = () => Number(stage().getAttribute('data-segment-index'));
const videos = () => screen.getAllByTestId('video-segment') as HTMLVideoElement[];
const activeVideo = () => videos().find((v) => v.getAttribute('data-active') === 'true')!;

describe('VideoPlayer', () => {
  let rafQueue: Array<(now: number) => void> = [];
  let now = 0;
  const media = {
    paused: new WeakMap<HTMLMediaElement, boolean>(),
    time: new WeakMap<HTMLMediaElement, number>(),
  };
  let play: jest.SpyInstance;
  let pause: jest.SpyInstance;

  beforeEach(() => {
    rafQueue = [];
    now = 1000;
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    // jsdom has no media pipeline: model paused/currentTime and a loaded element.
    play = jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      media.paused.set(this, false);
      return Promise.resolve();
    });
    pause = jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      media.paused.set(this, true);
    });
    jest.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
      return media.paused.get(this) ?? true;
    });
    jest.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
    jest.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(5);
    jest.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(function (this: HTMLMediaElement) {
      return media.time.get(this) ?? 0;
    });
    jest.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(function (
      this: HTMLMediaElement,
      v: number
    ) {
      media.time.set(this, v);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const tick = (ms: number) => {
    now += ms;
    const cbs = rafQueue;
    rafQueue = [];
    act(() => cbs.forEach((cb) => cb(now)));
  };

  it('mounts the first segment through the given URL and preloads the next one', () => {
    renderPlayer();
    expect(videos().map((v) => v.getAttribute('src'))).toEqual(['/proxy/seg/0', '/proxy/seg/1']);
    expect(activeVideo().getAttribute('data-seq')).toBe('0');
    expect(videos()[1]).toHaveAttribute('data-active', 'false');
    expect(videos()[1]).toHaveAttribute('preload', 'auto');
    expect(stage().style.aspectRatio).toBe(`${288 / 624}`);
    expect(screen.getByTestId('video-scrubber')).toHaveAttribute('max', String(durationMs));
    expect(screen.getByTestId('video-time')).toHaveTextContent('+0.0s / 17.0s');
  });

  it('maps a seek to the segment and the offset inside it, clamped, and reports it', () => {
    const { ref, onTime } = renderPlayer();
    act(() => ref.current!.goto(7250));
    expect(segmentIndex()).toBe(1);
    expect(activeVideo().getAttribute('data-seq')).toBe('1');
    expect(activeVideo().currentTime).toBeCloseTo(2.25);
    expect(videos().map((v) => v.getAttribute('data-seq'))).toEqual(['1', '2']);
    expect(onTime).toHaveBeenLastCalledWith(7250);
    act(() => ref.current!.goto(999_999));
    expect(segmentIndex()).toBe(2);
    expect(onTime).toHaveBeenLastCalledWith(durationMs);
    act(() => ref.current!.goto(-5));
    expect(segmentIndex()).toBe(0);
    expect(onTime).toHaveBeenLastCalledWith(0);
  });

  it('shows the last frame of the previous segment in a gap', () => {
    renderPlayer();
    fireEvent.change(screen.getByTestId('video-scrubber'), { target: { value: '11000' } });
    expect(segmentIndex()).toBe(1);
    expect(stage()).toHaveAttribute('data-in-gap', 'true');
    expect(screen.getByTestId('video-gap')).toHaveTextContent('last frame');
    expect(activeVideo().currentTime).toBeCloseTo(4.999);
    expect(activeVideo().paused).toBe(true);
  });

  it('plays the active segment, hands over to the next one, and stops at the end', () => {
    const { onTime } = renderPlayer();
    fireEvent.click(screen.getByTestId('video-play'));
    tick(0);
    expect(play).toHaveBeenCalled();
    expect(activeVideo().paused).toBe(false);
    tick(4000);
    expect(segmentIndex()).toBe(0);
    tick(1500); // 5.5 s: segment 1, which was preloaded
    expect(segmentIndex()).toBe(1);
    expect(activeVideo().getAttribute('data-seq')).toBe('1');
    expect(activeVideo().paused).toBe(false);
    tick(5000); // 10.5 s: gap, segment 1 pauses on its last frame
    expect(stage()).toHaveAttribute('data-in-gap', 'true');
    expect(activeVideo().paused).toBe(true);
    tick(2000); // 12.5 s: segment 2
    expect(segmentIndex()).toBe(2);
    expect(activeVideo().paused).toBe(false);
    tick(10_000);
    expect(onTime).toHaveBeenLastCalledWith(durationMs);
    expect(screen.getByTestId('video-play')).toHaveAttribute('aria-label', expect.stringMatching(/^Play/));
    expect(pause).toHaveBeenCalled();
  });

  it('holds the clock while the segment under the cursor is still loading, for at most 4 s', () => {
    jest.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1);
    const { onTime } = renderPlayer();
    fireEvent.click(screen.getByTestId('video-play'));
    tick(0);
    tick(1000);
    expect(onTime).not.toHaveBeenCalled();
    tick(3500); // hold budget used up: the clock runs on
    tick(500);
    expect(onTime).toHaveBeenLastCalledWith(500);
  });

  it('draws taps scaled to the stage, fully visible for 1 s then fading until 1.5 s', () => {
    const { ref } = renderPlayer();
    act(() => ref.current!.goto(2000));
    let taps = screen.getAllByTestId('video-tap');
    expect(taps).toHaveLength(1);
    expect(taps[0].style.left).toBe('50%');
    expect(taps[0].style.top).toBe('50%');
    expect(Number(taps[0].style.opacity)).toBeCloseTo(1);
    // About one video frame later the tap is still fully visible.
    act(() => ref.current!.goto(2900));
    expect(Number(screen.getByTestId('video-tap').style.opacity)).toBeCloseTo(1);
    act(() => ref.current!.goto(3250));
    expect(Number(screen.getByTestId('video-tap').style.opacity)).toBeCloseTo(0.5);
    act(() => ref.current!.goto(3501));
    expect(screen.queryByTestId('video-tap')).toBeNull();
    // A touch with only an `ended` phase is still a tap.
    act(() => ref.current!.goto(6500));
    taps = screen.getAllByTestId('video-tap');
    expect(taps[0].style.left).toBe('25%');
  });

  it('labels a tap with its component and shows a breadcrumb-only tap without a position', () => {
    const ref = React.createRef<ReplayHandle>();
    render(
      <VideoPlayer
        ref={ref}
        manifest={videoManifest}
        startTs={VIDEO_START}
        durationMs={durationMs}
        segmentUrl={(s) => `/proxy/seg/${s.seq}`}
        taps={[
          { ts: VIDEO_START + 2000, x: 144, y: 312, target: 'btn-Add to cart' },
          { ts: VIDEO_START + 8000, target: 'action-fetch-ok' },
        ]}
      />
    );
    act(() => ref.current!.goto(2100));
    expect(screen.getByTestId('video-tap')).toHaveAttribute('data-target', 'btn-Add to cart');
    expect(screen.getByTestId('video-tap')).toHaveTextContent('btn-Add to cart');
    expect(screen.queryByTestId('video-tap-unplaced')).toBeNull();
    act(() => ref.current!.goto(8200));
    expect(screen.queryByTestId('video-tap')).toBeNull();
    expect(screen.getByTestId('video-tap-unplaced')).toHaveTextContent('action-fetch-ok');
  });

  it('draws the moves of a drag as a trail', () => {
    const { ref } = renderPlayer(jest.fn(), {
      ...videoManifest,
      touches: [
        { ts: VIDEO_START + 1000, x: 100, y: 500, phase: 'began' },
        { ts: VIDEO_START + 1100, x: 100, y: 400, phase: 'moved' },
        { ts: VIDEO_START + 1200, x: 100, y: 300, phase: 'ended' },
      ],
    });
    act(() => ref.current!.goto(1300));
    expect(screen.getAllByTestId('video-tap')).toHaveLength(1);
    expect(screen.getAllByTestId('video-touch')).toHaveLength(1);
    expect(screen.getByTestId('video-touch')).toHaveAttribute('data-phase', 'moved');
  });

  it('shows the Sentry source badge with the replay id', () => {
    renderPlayer();
    const badge = screen.getByTestId('video-source');
    expect(badge).toHaveTextContent('Sentry replay');
    expect(badge).toHaveAttribute('data-vendor', 'sentry');
  });

  it('has no badge without a source', () => {
    renderPlayer(jest.fn(), { ...videoManifest, source: null });
    expect(screen.queryByTestId('video-source')).toBeNull();
  });

  it('reports an undecodable segment and keeps the clock and taps running', () => {
    const { ref } = renderPlayer();
    // jsdom's media elements have no `error`; set what a browser reports for a non-mp4 body.
    Object.defineProperty(activeVideo(), 'error', { configurable: true, value: { code: 4 } });
    fireEvent.error(activeVideo());
    expect(screen.getByTestId('video-error')).toHaveTextContent('Segment 0 could not be played');
    act(() => ref.current!.goto(2000));
    expect(screen.getAllByTestId('video-tap')).toHaveLength(1);
  });

  it('marks a segment loaded once it has data', () => {
    renderPlayer();
    expect(screen.getByTestId('video-loading')).toHaveTextContent('Loading segment 0');
    fireEvent.loadedData(activeVideo());
    expect(screen.queryByTestId('video-loading')).toBeNull();
  });

  it('space toggles, arrows step one frame (1 s at 1 fps), shift+arrows one segment', () => {
    const { onTime } = renderPlayer();
    const region = screen.getByTestId('video-player');
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(onTime).toHaveBeenLastCalledWith(1000);
    fireEvent.keyDown(region, { key: 'ArrowRight', shiftKey: true });
    expect(onTime).toHaveBeenLastCalledWith(5000);
    fireEvent.keyDown(region, { key: 'ArrowRight', shiftKey: true });
    expect(onTime).toHaveBeenLastCalledWith(12_000);
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(onTime).toHaveBeenLastCalledWith(11_000);
    fireEvent.keyDown(region, { key: 'ArrowLeft', shiftKey: true });
    expect(onTime).toHaveBeenLastCalledWith(5000);
    fireEvent.keyDown(region, { key: 'End' });
    expect(onTime).toHaveBeenLastCalledWith(durationMs);
    fireEvent.keyDown(region, { key: 'Home' });
    expect(onTime).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(region, { key: ' ' });
    expect(screen.getByTestId('video-play')).toHaveAttribute('aria-label', expect.stringMatching(/^Pause/));
  });

  it('renders an empty state without segments', () => {
    renderPlayer(jest.fn(), { ...videoManifest, segments: [] });
    expect(screen.getByText('The replay has no video segments yet.')).toBeInTheDocument();
  });
});
