import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReplayFrame, ReplayFramesResponse } from '../api/types';
import fixture from '../__fixtures__/frames.json';
import { FramePlayer } from './FramePlayer';
import type { ReplayHandle } from './ReplayPlayer';

const resp = fixture as ReplayFramesResponse;
const start = resp.started_at;
const durationMs = resp.ended_at - resp.started_at;

function renderPlayer(onTime = jest.fn()) {
  const ref = React.createRef<ReplayHandle>();
  const utils = render(
    <FramePlayer
      ref={ref}
      frames={resp.frames}
      touches={resp.touches}
      viewport={resp.viewport}
      startTs={start}
      durationMs={durationMs}
      onTime={onTime}
    />
  );
  return { ref, onTime, ...utils };
}

const frameIndex = () => Number(screen.getByTestId('frame-canvas').getAttribute('data-frame-index'));

describe('FramePlayer', () => {
  let rafQueue: Array<(now: number) => void> = [];
  let now = 0;

  beforeEach(() => {
    rafQueue = [];
    now = 1000;
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    jest.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  /** Advances the fake clock by `ms` and runs the pending animation frame. */
  const tick = (ms: number) => {
    now += ms;
    const cbs = rafQueue;
    rafQueue = [];
    act(() => cbs.forEach((cb) => cb(now)));
  };

  it('renders the first frame on a stage sized to the viewport aspect ratio', () => {
    renderPlayer();
    expect(screen.getByTestId('frame-canvas')).toHaveAttribute('aria-label', 'Frame 1 of 5 (resume)');
    expect(frameIndex()).toBe(0);
    const stage = screen.getByTestId('frame-stage');
    expect(stage.style.aspectRatio).toBe(`${393 / 852}`);
    expect(screen.getByTestId('frame-scrubber')).toHaveAttribute('max', String(durationMs));
    expect(screen.getByTestId('frame-time')).toHaveTextContent('+0.0s / 7.0s');
  });

  it('seeks through the ref handle, clamped, and reports the offset', () => {
    const { ref, onTime } = renderPlayer();
    act(() => ref.current!.goto(2300));
    expect(frameIndex()).toBe(2);
    expect(onTime).toHaveBeenLastCalledWith(2300);
    act(() => ref.current!.goto(999_999));
    expect(frameIndex()).toBe(4);
    expect(onTime).toHaveBeenLastCalledWith(durationMs);
    act(() => ref.current!.goto(-50));
    expect(frameIndex()).toBe(0);
    expect(onTime).toHaveBeenLastCalledWith(0);
  });

  it('scrubs with the range input', () => {
    const { onTime } = renderPlayer();
    fireEvent.change(screen.getByTestId('frame-scrubber'), { target: { value: '4100' } });
    expect(frameIndex()).toBe(3);
    expect(onTime).toHaveBeenLastCalledWith(4100);
  });

  it('plays with requestAnimationFrame at 1x and 2x and stops at the end', () => {
    const { onTime } = renderPlayer();
    fireEvent.click(screen.getByTestId('frame-play'));
    expect(screen.getByLabelText('Pause (space)')).toBeInTheDocument();
    tick(0); // first frame: no elapsed time
    tick(1100);
    expect(frameIndex()).toBe(1);
    expect(onTime).toHaveBeenLastCalledWith(1100);

    fireEvent.click(screen.getByText('2×'));
    tick(0);
    tick(700); // +1400 at 2x -> 2500
    expect(frameIndex()).toBe(2);

    tick(10_000);
    expect(frameIndex()).toBe(4);
    expect(onTime).toHaveBeenLastCalledWith(durationMs);
    expect(screen.getByLabelText('Play (space)')).toBeInTheDocument();
    expect(rafQueue).toHaveLength(0);
  });

  it('shows touch indicators for 500 ms after a touch, fading out', () => {
    const { ref } = renderPlayer();
    act(() => ref.current!.goto(2200));
    let dots = screen.getAllByTestId('frame-touch');
    expect(dots).toHaveLength(1);
    expect(dots[0].getAttribute('data-phase')).toBe('began');
    expect(dots[0].style.opacity).toBe('1');
    expect(dots[0].style.left).toBe(`${(196 / 393) * 100}%`);

    act(() => ref.current!.goto(2500));
    dots = screen.getAllByTestId('frame-touch');
    expect(dots).toHaveLength(3);
    expect(Number(dots[0].style.opacity)).toBeCloseTo(0.4);

    act(() => ref.current!.goto(2801));
    expect(screen.queryAllByTestId('frame-touch')).toHaveLength(0);
  });

  it('space toggles playback and arrow keys step one frame', () => {
    renderPlayer();
    const player = screen.getByTestId('frame-player');
    fireEvent.keyDown(player, { key: ' ' });
    expect(screen.getByLabelText('Pause (space)')).toBeInTheDocument();
    fireEvent.keyDown(player, { key: ' ' });
    expect(screen.getByLabelText('Play (space)')).toBeInTheDocument();

    fireEvent.keyDown(player, { key: 'ArrowRight' });
    expect(frameIndex()).toBe(1);
    fireEvent.keyDown(player, { key: 'ArrowRight' });
    expect(frameIndex()).toBe(2);
    fireEvent.keyDown(player, { key: 'ArrowLeft' });
    expect(frameIndex()).toBe(1);
    fireEvent.keyDown(player, { key: 'ArrowLeft' });
    fireEvent.keyDown(player, { key: 'ArrowLeft' });
    expect(frameIndex()).toBe(0);
    fireEvent.keyDown(player, { key: 'End' });
    expect(frameIndex()).toBe(4);
  });

  describe('canvas painting (schema 2 patches)', () => {
    let draws: unknown[][];
    let sizes: Map<string, [number, number]>;
    beforeEach(() => {
      draws = [];
      sizes = new Map();
      const ctx = { drawImage: (img: HTMLImageElement, ...rest: number[]) => draws.push([img.src, ...rest]) };
      jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as never);
      // jsdom loads no images: setting src fires load (error for BROKEN), sizes come from `sizes`.
      jest.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
        this: HTMLImageElement,
        v: string
      ) {
        this.setAttribute('src', v);
        queueMicrotask(() => (v.includes('BROKEN') ? this.onerror : this.onload)?.call(this, new Event('load')));
      });
      jest.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(function (
        this: HTMLImageElement
      ) {
        return sizes.get(this.src)?.[0] ?? 0;
      });
      jest.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockImplementation(function (
        this: HTMLImageElement
      ) {
        return sizes.get(this.src)?.[1] ?? 0;
      });
    });

    const url = (b64: string) => `data:image/jpeg;base64,${b64}`;
    const t0 = 1_760_000_000_000;
    const frames: ReplayFrame[] = [
      { ts: t0, reason: 'change', jpeg: 'FULL1' },
      { ts: t0 + 1000, reason: 'change', patches: [{ x: 0, y: 64, w: 64, h: 64, jpeg: 'P1' }] },
      {
        ts: t0 + 2000,
        reason: 'change',
        patches: [
          { x: 64, y: 0, w: 32, h: 64, jpeg: 'P2A' },
          { x: 0, y: 0, w: 64, h: 64, jpeg: 'P2B' },
        ],
      },
      // next chunk: a new full image, then a patch whose image does not decode
      { ts: t0 + 5000, reason: 'change', jpeg: 'FULL2' },
      { ts: t0 + 6000, reason: 'change', patches: [{ x: 0, y: 0, w: 8, h: 8, jpeg: 'BROKEN' }] },
    ];
    const renderPatches = () => {
      const ref = React.createRef<ReplayHandle>();
      render(
        <FramePlayer
          ref={ref}
          frames={frames}
          touches={[]}
          viewport={{ width: 96, height: 128, scale: 1 }}
          startTs={t0}
          durationMs={7000}
        />
      );
      return ref;
    };

    it('draws the full image sized to the canvas, then blits patches in order', async () => {
      sizes.set(url('FULL1'), [96, 128]);
      const ref = renderPatches();
      await waitFor(() => expect(draws).toEqual([[url('FULL1'), 0, 0]]));
      const canvas = screen.getByTestId('frame-canvas') as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([96, 128]);

      draws = [];
      act(() => ref.current!.goto(2500)); // frame 2: full image, then frames 1 and 2 patches
      await waitFor(() =>
        expect(draws).toEqual([
          [url('FULL1'), 0, 0],
          [url('P1'), 0, 64, 64, 64],
          [url('P2A'), 64, 0, 32, 64],
          [url('P2B'), 0, 0, 64, 64],
        ])
      );
    });

    it('scrubbing back before the first frame paints the first full image again', async () => {
      sizes.set(url('FULL1'), [96, 128]);
      const ref = renderPatches();
      act(() => ref.current!.goto(2500));
      await waitFor(() => expect(draws.length).toBeGreaterThan(1));
      draws = [];
      act(() => ref.current!.goto(-1000));
      await waitFor(() => expect(draws).toEqual([[url('FULL1'), 0, 0]]));
    });

    it('seeks into a later chunk from its own full image and skips a patch that does not decode', async () => {
      sizes.set(url('FULL2'), [48, 64]);
      const ref = renderPatches();
      draws = [];
      act(() => ref.current!.goto(6500));
      await waitFor(() => expect(draws).toEqual([[url('FULL2'), 0, 0]]));
      const canvas = screen.getByTestId('frame-canvas') as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([48, 64]);
    });
  });

  it('renders an empty state without frames', () => {
    render(<FramePlayer frames={[]} touches={[]} viewport={resp.viewport} startTs={start} durationMs={0} />);
    expect(screen.getByText('The replay has no frames yet.')).toBeInTheDocument();
  });
});
