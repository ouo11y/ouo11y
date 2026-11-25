// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkEntry } from '../manifest';
import { VideoPlayer } from './VideoPlayer';

// jsdom decodes no video and has no object URLs: the stubs stand in, the player's own logic is
// what is under test.
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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
  vi.restoreAllMocks();
});

describe('VideoPlayer', () => {
  it('plays the segments in sequence order, prefetches the next one, and goes over a gap', async () => {
    const fetch = vi.fn(async (seq: number) => body(seq));
    render(<VideoPlayer chunks={[chunk(3), chunk(0), chunk(1)]} fetchChunk={fetch} />);
    await waitFor(() => expect(seqOf()).toBe(0));
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(screen.getByText('0:00 / 0:15')).toBeTruthy();
    fireEvent.ended(screen.getByTestId('ouo-replay-video-element'));
    await waitFor(() => expect(seqOf()).toBe(1));
    fireEvent.ended(screen.getByTestId('ouo-replay-video-element'));
    await waitFor(() => expect(seqOf()).toBe(3));
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([0, 1, 3]);
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

  it('draws a touch at (x * scale, y * scale) when the video reaches it, and reports the time', async () => {
    const onTime = vi.fn();
    const touch = { t: 11_200, x: 50, y: 100, phase: 'began' };
    render(<VideoPlayer chunks={[chunk(0)]} fetchChunk={async () => body(0, [touch])} onTime={onTime} />);
    await waitFor(() => expect(seqOf()).toBe(0));
    const video = screen.getByTestId('ouo-replay-video-element') as HTMLVideoElement;
    video.currentTime = 1.5;
    fireEvent.timeUpdate(video);
    const circle = await screen.findByTestId('ouo-replay-touch');
    expect([circle.getAttribute('cx'), circle.getAttribute('cy')]).toEqual(['100', '200']);
    expect(onTime).toHaveBeenLastCalledWith(1500);
    video.currentTime = 3;
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(screen.queryByTestId('ouo-replay-touch')).toBeNull());
  });

  it('seeks across segments with the scrubber, and plays at the picked speed', async () => {
    render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await waitFor(() => expect(seqOf()).toBe(0));
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '7000' } });
    await waitFor(() => expect(seqOf()).toBe(1));
    const video = screen.getByTestId('ouo-replay-video-element') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(2);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('Play'));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(video.playbackRate).toBe(4);
  });

  it('seeks back into the segment still on screen while another one loads', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => (release = r));
    const fetch = async (seq: number) => (seq === 2 ? slow.then(() => body(seq)) : body(seq));
    render(<VideoPlayer chunks={[chunk(0), chunk(1), chunk(2)]} fetchChunk={fetch} />);
    await waitFor(() => expect(seqOf()).toBe(0));
    const scrubber = screen.getByLabelText('Replay position');
    fireEvent.change(scrubber, { target: { value: '12000' } }); // segment 2, still loading
    expect(screen.getByText('Loading segment 2…')).toBeTruthy();
    fireEvent.change(scrubber, { target: { value: '1000' } }); // back to segment 0, on screen
    const video = screen.getByTestId('ouo-replay-video-element') as HTMLVideoElement;
    await waitFor(() => expect(video.currentTime).toBe(1));
    expect(screen.queryByText(/Loading segment/)).toBeNull();
    release();
  });

  it('starts over when Play is pressed after the last segment ended', async () => {
    render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await waitFor(() => expect(seqOf()).toBe(0));
    fireEvent.click(screen.getByLabelText('Play'));
    fireEvent.ended(screen.getByTestId('ouo-replay-video-element'));
    await waitFor(() => expect(seqOf()).toBe(1));
    fireEvent.ended(screen.getByTestId('ouo-replay-video-element'));
    await screen.findByLabelText('Play');
    fireEvent.click(screen.getByLabelText('Play'));
    await waitFor(() => expect(seqOf()).toBe(0));
    expect(screen.getByLabelText('Pause')).toBeTruthy();
  });

  it('revokes its object URLs when it unmounts', async () => {
    const { unmount } = render(<VideoPlayer chunks={[chunk(0), chunk(1)]} fetchChunk={async (seq) => body(seq)} />);
    await waitFor(() => expect(created).toHaveLength(2));
    await act(async () => unmount());
    expect(revoked.mock.calls.map((c) => c[0]).sort()).toEqual([...created].sort());
  });
});
