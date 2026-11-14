// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChunkEntry, Manifest } from '../manifest';
import { ReplayPlayer } from './ReplayPlayer';

// rrweb-player renders into an iframe, which jsdom does not lay out; the player's own logic is
// what is under test here.
vi.mock('./RrwebPlayer', () => ({
  RrwebPlayer: ({ events }: { events: unknown[] }) => <div data-testid="rrweb">{events.length} events</div>,
}));

const chunk = (sequence: number, keyframe: boolean): ChunkEntry => ({
  sequence, keyframe, segment_index: 0, start_time: sequence, end_time: sequence, format: 'rrweb/2',
  encoding: 'gzip', byte_size: 1, sha256: '', received_at: 0, attributes: null,
});
const manifest: Manifest = {
  session_id: 's', replay_id: 'r', project: 'p', state: 'complete', start_time: 0, end_time: 1,
  chunk_count: 2, byte_size: 2,
  streams: [{ stream_id: 'st', state: 'complete', start_time: 0, end_time: 1, end: null, missing: null,
    chunks: [chunk(0, true), chunk(1, false)] }],
};
const bodies = ['{"type":4,"timestamp":1}\n{"type":2,', '"timestamp":2}\n'];
const fetcher = () =>
  vi.fn(async (_stream: string, seq: number) => new TextEncoder().encode(bodies[seq]).buffer as ArrayBuffer);

afterEach(cleanup);

describe('ReplayPlayer', () => {
  it('assembles the runs and plays them', async () => {
    const f = fetcher();
    render(<ReplayPlayer manifest={manifest} fetchChunk={f} />);
    expect(await screen.findByTestId('rrweb')).toHaveProperty('textContent', '2 events');
    expect(f.mock.calls.map((c) => c[1]).sort()).toEqual([0, 1]);
  });

  it('does not reload when the parent passes a new fetcher identity', async () => {
    const first = fetcher();
    const { rerender } = render(<ReplayPlayer manifest={manifest} fetchChunk={first} />);
    await screen.findByTestId('rrweb');
    const second = fetcher();
    await act(async () => rerender(<ReplayPlayer manifest={manifest} fetchChunk={second} />));
    expect(screen.getByTestId('rrweb').textContent).toBe('2 events');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
  });

  it('says why a format cannot be played', async () => {
    const pixel: Manifest = { ...manifest, streams: [{ ...manifest.streams![0], chunks: [{ ...chunk(0, true), format: 'ouo-video/1' }] }] };
    render(<ReplayPlayer manifest={pixel} fetchChunk={fetcher()} />);
    expect((await screen.findByText(/Stored, not playable here/)).textContent).toMatch(/ouo-video\/1/);
  });
});
