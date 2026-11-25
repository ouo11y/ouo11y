import { describe, expect, it } from 'vitest';
import type { ChunkEntry } from '../manifest';
import { locateSegment, parseVideoChunk, touchesAt, videoTimeline } from './video';

const MP4 = '\0\0\0\x18ftypisom'; // 12 bytes; jsdom decodes nothing, the length is what counts
const header = { t: 1000, type: 'video', end: 6000, w: 402, h: 874, scale: 2, fps: 1, frames: 5, mp4: MP4.length,
  touches: [{ t: 2200, x: 10, y: 20, phase: 'began' }] };
const body = (h: unknown, mp4 = MP4) => new TextEncoder().encode(`${JSON.stringify(h)}\n${mp4}`).buffer as ArrayBuffer;
const chunk = (sequence: number, start: number, end: number): ChunkEntry => ({
  sequence, keyframe: true, segment_index: sequence, start_time: start, end_time: end, format: 'ouo-video/1',
  encoding: 'identity', byte_size: 1, sha256: '', received_at: 0, attributes: null,
});

describe('parseVideoChunk', () => {
  it('splits the header line from the mp4 bytes', () => {
    const { header: h, mp4 } = parseVideoChunk(body(header));
    expect(h).toMatchObject({ t: 1000, end: 6000, w: 402, h: 874, scale: 2, fps: 1, frames: 5, mp4: 12 });
    expect(h.touches).toEqual([{ t: 2200, x: 10, y: 20, phase: 'began' }]);
    expect(new TextDecoder().decode(mp4)).toBe(MP4);
  });
  it('keeps a newline byte inside the mp4', () => {
    const mp4 = 'ab\ncd';
    expect(parseVideoChunk(body({ ...header, mp4: mp4.length }, mp4)).mp4.byteLength).toBe(5);
  });
  it('refuses a chunk without a newline', () => {
    expect(() => parseVideoChunk(new TextEncoder().encode(JSON.stringify(header)).buffer as ArrayBuffer)).toThrow(/no newline/);
  });
  it('refuses an mp4 of another length than the header says', () => {
    expect(() => parseVideoChunk(body({ ...header, mp4: 99 }))).toThrow(/says 99 mp4 bytes, the chunk holds 12/);
    expect(() => parseVideoChunk(body(header, MP4.slice(1)))).toThrow(/holds 11/);
  });
  it('refuses a header that is not JSON or lacks a field', () => {
    expect(() => parseVideoChunk(new TextEncoder().encode(`{"t":1\n${MP4}`).buffer as ArrayBuffer)).toThrow(/not JSON/);
    expect(() => parseVideoChunk(body({ ...header, w: undefined }))).toThrow(/"w"/);
  });
  it('defaults scale and fps and drops a malformed touch', () => {
    const { header: h } = parseVideoChunk(body({ ...header, scale: undefined, fps: 0, touches: [{ t: 1 }, null, header.touches[0]] }));
    expect(h.scale).toBe(1);
    expect(h.fps).toBe(1);
    expect(h.touches).toHaveLength(1);
  });
});

describe('videoTimeline', () => {
  it('plays in sequence order and lays a gap back to back', () => {
    const { segments, total } = videoTimeline([chunk(3, 30_000, 35_000), chunk(0, 0, 5000), chunk(1, 5000, 8000)]);
    expect(segments.map((s) => [s.chunk.sequence, s.offset, s.duration])).toEqual([[0, 0, 5000], [1, 5000, 3000], [3, 8000, 5000]]);
    expect(total).toBe(13_000);
  });
  it('locates an offset, clamping before the start and past the end', () => {
    const { segments } = videoTimeline([chunk(0, 0, 5000), chunk(2, 9000, 12_000)]);
    expect(locateSegment(segments, 6500)).toEqual({ index: 1, local: 1500 });
    expect(locateSegment(segments, 5000)).toEqual({ index: 1, local: 0 });
    expect(locateSegment(segments, -10)).toEqual({ index: 0, local: 0 });
    expect(locateSegment(segments, 99_999)).toEqual({ index: 1, local: 3000 });
    expect(locateSegment([], 0)).toEqual({ index: -1, local: 0 });
  });
});

describe('touchesAt', () => {
  it('draws a touch for one frame from t - header.t', () => {
    const h = parseVideoChunk(body(header)).header;
    expect(touchesAt(h, 1199)).toEqual([]);
    expect(touchesAt(h, 1200)).toHaveLength(1);
    expect(touchesAt(h, 2199)).toHaveLength(1);
    expect(touchesAt(h, 2200)).toEqual([]);
  });
});
