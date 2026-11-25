import { describe, expect, it } from 'vitest';
import type { ChunkEntry, StreamEntry } from '../manifest';
import { formatInfo } from './formats';
import { parseNdjson, playableRuns, primaryStream } from './assemble';

const chunk = (sequence: number, keyframe = false): ChunkEntry => ({
  sequence, keyframe, segment_index: 0, start_time: sequence, end_time: sequence, format: 'rrweb/2',
  encoding: 'gzip', byte_size: 1, sha256: '', received_at: 0, attributes: null,
});
const stream = (chunks: ChunkEntry[], start = 0): StreamEntry => ({
  stream_id: 's' + start, state: 'complete', start_time: start, end_time: start, end: null, missing: null, chunks,
});
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('playableRuns', () => {
  it('starts at a keyframe and stops at a gap, resuming at the next keyframe', () => {
    const runs = playableRuns(stream([chunk(3), chunk(0, true), chunk(1), chunk(4), chunk(5, true), chunk(6), chunk(8, true)]));
    expect(runs.map((r) => r.map((c) => c.sequence))).toEqual([[0, 1], [5, 6], [8]]);
  });
  it('has nothing to play without a keyframe', () => {
    expect(playableRuns(stream([chunk(1), chunk(2)]))).toEqual([]);
    expect(playableRuns(stream([]))).toEqual([]);
  });
});

describe('parseNdjson', () => {
  it('joins lines split across chunks and skips a cut-off tail', () => {
    const parts = [enc('{"type":4,"timestamp":1}\n{"type":2,'), enc('"timestamp":2}\n{"type":3')];
    expect(parseNdjson(parts)).toEqual([{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }]);
  });
});

describe('primaryStream', () => {
  it('is the earliest stream that has something to play', () => {
    const early = stream([chunk(1)], 1);
    const late = stream([chunk(0, true)], 5);
    expect(primaryStream([late, early])).toBe(late);
  });
});

describe('formatInfo', () => {
  it('plays rrweb/2 and ouo-video/1, names the seam for frames, and never throws on unknown ids', () => {
    expect(formatInfo('rrweb/2').renderer).toBe('rrweb');
    expect(formatInfo('ouo-video/1')).toMatchObject({ kind: 'pixel', renderer: 'video' });
    expect(formatInfo('ouo-frames/3').kind).toBe('pixel');
    expect(formatInfo('ouo-frames/3').renderer).toBeUndefined();
    expect(formatInfo('ouo-frames/3').reason).toMatch(/not wired/);
    expect(formatInfo('something/9')).toMatchObject({ kind: 'unknown' });
  });
});
