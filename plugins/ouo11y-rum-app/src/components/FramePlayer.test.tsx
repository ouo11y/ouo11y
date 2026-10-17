import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReplayFramesResponse } from '../api/types';
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

const frameIndex = () => Number(screen.getByTestId('frame-img').getAttribute('data-frame-index'));

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

  it('renders the first frame as a JPEG data URL sized to the viewport aspect ratio', () => {
    renderPlayer();
    const img = screen.getByTestId('frame-img');
    expect(img.getAttribute('src')).toBe(`data:image/jpeg;base64,${resp.frames[0].jpeg}`);
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

  it('renders an empty state without frames', () => {
    render(
      <FramePlayer frames={[]} touches={[]} viewport={resp.viewport} startTs={start} durationMs={0} />
    );
    expect(screen.getByText('The replay has no frames yet.')).toBeInTheDocument();
  });
});
