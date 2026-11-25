// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkEntry } from '../manifest';
import { VideoPlayer } from './VideoPlayer';

// jsdom decodes no video and has no object URLs: the stubs stand in, the player's own logic is
// what is under test. The player keeps its own clock on requestAnimationFrame; `advance` runs it.
const MP4 = '\0\0\0\x18ftypisom';
const chunk = (sequence: number): ChunkEntry => ({
  sequence, keyframe: true, segment_index: sequence, start_time: 10_000 + sequence * 5000, end_time: 15_000 + sequence * 5000,
  format: 'ouo-video/1', encoding: 'identity', byte_size: 1, sha256: '', received_at: 0, attributes: null,
});
const body = (seq: number, touches: unknown[] = []) => {
  const t = 10_000 + seq * 5000;
  const h = { t, type: 'video', end: t + 5000, w: 400, h: 800, scale: 2, fps: 1, frames: 5, mp4: MP4.length, touches };
  return new TextEncoder().encode(`${JSON.stringify(h)}\n${MP4}`).buffer as ArrayBuffer;
};
const seqOf = () => Number(screen.getByTestId('ouo-replay-video-element').getAttribute('data-seq'));
const video = () => screen.getByTestId('ouo-replay-video-element') as HTMLVideoElement;
const position = () => Number((screen.getByLabelText('Replay position') as HTMLInputElement).value);
/** The element has loaded the segment on screen: its frames can be shown. */
const loaded = async (seq: number) => {
  await waitFor(() => expect(seqOf()).toBe(seq));
  fireEvent.loadedMetadata(video());
};

let now = 0;
let frames: FrameRequestCallback[] = [];
/** Runs the animation frames for `ms` of wall time, one every `step` ms. */
const advance = async (ms: number, step = 16) => {
  for (let t = 0; t < ms; t += step) {
    now += step;
    const run = frames;
    frames = [];
    await act(async () => run.forEach((f) => f(now)));
  }
};

let created: string[];
const revoked = vi.fn();
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  created = [];
  URL.createObjectURL = () => {
    created.push(`blob:${created.length}`);
    return created[created.length - 1];
  };
  URL.revokeObjectURL = revoked;
  revoked.mockClear();
  now = 0;
  frames = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => (frames = []));
  // The player never plays the element: it seeks a paused one, frame by frame.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('play() called'));
});
afterEach(() => {
  cleanup();
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VideoPlayer', () => {
  it('plays the segments in sequence order, prefetches the next one, and goes over a gap', async () => {
    const fetch = vi.fn(async (seq: number) => body(seq));
    render(<VideoPlayer chunks={[chunk(3), chunk(0), chunk(1)]} fetchChunk={fetch} />);
    await loaded(0);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(screen.getByText('0:00 / 0:15')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Play'));
    await advance(5000);
    expect(seqOf()).toBe(1);
    // the clock waits for the next segment's metadata
    await advance(2000);
    expect(position()).toBe(5000);
    fireEvent.loadedMetadata(video());
    await advance(5000);
    await loaded(3);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([0, 1, 3]);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('names a bad chunk and moves on to the next segment', async () => {
    const fetch = vi.fn(async (seq: number) => {
      if (seq === 0) {
        return new TextEncoder().encode('no header').buffer as ArrayBuffer;
      }
      if (seq === 1) {
        throw new Error('HTTP 502');
      }
      return body(seq);
    });
    render(<VideoPlayer chunks={[chunk(0), chunk(1), chunk(2)]} fetchChunk={fetch} />);
    await waitFor(() => expect(seqOf()).toBe(2));
    expect(screen.getByText(/Segment 0 skipped: no header line/)).toBeTruthy();
    expect(screen.getByText(/Segment 1 skipped: HTTP 502/)).toBeTruthy();
  });

  it('skips a segment the browser cannot decode', async () => {
    render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await waitFor(() => expect(seqOf()).toBe(0));
    fireEvent.error(screen.getByTestId('ouo-replay-video-element'));
    await waitFor(() => expect(seqOf()).toBe(1));
    expect(screen.getByText(/Segment 0 skipped/)).toBeTruthy();
  });

  it('draws a touch at (x * scale, y * scale) for one second from its time, and reports the time', async () => {
    const onTime = vi.fn();
    const touch = { t: 11_200, x: 50, y: 100, phase: 'began' };
    render(<VideoPlayer chunks={[chunk(0)]} fetchChunk={async () => body(0, [touch])} onTime={onTime} />);
    await loaded(0);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '1500' } });
    const circle = await screen.findByTestId('ouo-replay-touch');
    expect([circle.getAttribute('cx'), circle.getAttribute('cy')]).toEqual(['100', '200']);
    expect(onTime).toHaveBeenLastCalledWith(1500);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '2200' } });
    expect(screen.queryByTestId('ouo-replay-touch')).toBeNull();
  });

  it('draws every touch at 8x, where the element would report its time too seldom', async () => {
    const touch = { t: 12_300, x: 50, y: 100, phase: 'began' };
    render(<VideoPlayer chunks={[chunk(0)]} fetchChunk={async () => body(0, [touch])} />);
    await loaded(0);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '8' } });
    fireEvent.click(screen.getByLabelText('Play'));
    let seen = false;
    for (let i = 0; i < 30 && !seen; i++) {
      await advance(16);
      seen = screen.queryByTestId('ouo-replay-touch') !== null;
    }
    expect(seen).toBe(true);
    expect(position()).toBeGreaterThanOrEqual(2300);
    expect(position()).toBeLessThan(3300);
  });

  it('seeks across segments with the scrubber, and plays at the picked speed', async () => {
    render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await loaded(0);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '7000' } });
    await loaded(1);
    expect(video().currentTime).toBe(2);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('Play'));
    await advance(496);
    expect(position()).toBeGreaterThanOrEqual(8900);
    expect(position()).toBeLessThanOrEqual(9000);
    expect(Math.floor(video().currentTime)).toBe(3);
  });

  it('seeks the paused element once per frame, not on every clock tick', async () => {
    render(<VideoPlayer chunks={[chunk(0)]} fetchChunk={async () => body(0)} />);
    await loaded(0);
    const el = video();
    const set = vi.fn();
    let ct = 0;
    Object.defineProperty(el, 'currentTime', { configurable: true, get: () => ct, set: (v: number) => (set(v), (ct = v)) });
    fireEvent.click(screen.getByLabelText('Play'));
    await advance(4500);
    // frames 1 to 4 of the 1 frame/s segment
    expect(set.mock.calls.map((c) => Math.floor(c[0]))).toEqual([1, 2, 3, 4]);
  });

  it('seeks back into the segment still on screen while another one loads', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => (release = r));
    const fetch = async (seq: number) => (seq === 2 ? slow.then(() => body(seq)) : body(seq));
    render(<VideoPlayer chunks={[chunk(0), chunk(1), chunk(2)]} fetchChunk={fetch} />);
    await loaded(0);
    const scrubber = screen.getByLabelText('Replay position');
    fireEvent.change(scrubber, { target: { value: '12000' } }); // segment 2, still loading
    expect(screen.getByText('Loading segment 2…')).toBeTruthy();
    fireEvent.change(scrubber, { target: { value: '1000' } }); // back to segment 0, on screen
    await waitFor(() => expect(video().currentTime).toBe(1));
    expect(screen.queryByText(/Loading segment/)).toBeNull();
    release();
  });

  it('starts over when Play is pressed after the last segment ended', async () => {
    render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await loaded(0);
    fireEvent.click(screen.getByLabelText('Play'));
    await advance(5000);
    await loaded(1);
    await advance(5500);
    expect(screen.getByLabelText('Play')).toBeTruthy();
    expect(position()).toBe(10_000);
    fireEvent.click(screen.getByLabelText('Play'));
    await loaded(0);
    expect(screen.getByLabelText('Pause')).toBeTruthy();
    await advance(1000);
    expect(position()).toBeGreaterThan(900);
  });

  it('revokes its object URLs when it unmounts', async () => {
    const { unmount } = render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await waitFor(() => expect(created).toHaveLength(2));
    await act(async () => unmount());
    expect(revoked.mock.calls.map((c) => c[0]).sort()).toEqual([...created].sort());
  });
});
