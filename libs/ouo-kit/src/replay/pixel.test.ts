import { describe, expect, it } from 'vitest';
import { drawListAt, frameAt, parseVideoChunk, segmentAt, splitFrames, touchesAt, type VideoSegment } from './pixel';

const frame = (t: number) => ({ t, type: 'frame', w: 100, h: 200, scale: 0.5, reason: 'timer', jpeg: 'AAAA' });
const patch = (t: number) => ({ t, type: 'patch', reason: 'change', patches: [{ x: 0, y: 0, w: 10, h: 10, jpeg: 'BB' }] });

describe('ouo-frames/3', () => {
  const { images, touches } = splitFrames([
    patch(5), // before any full image: dropped
    frame(10),
    { t: 12, type: 'touch', x: 20, y: 40, phase: 'began' },
    patch(20),
    patch(30),
    frame(40),
    patch(50),
    { t: 'bad' },
  ]);

  it('keeps images from the first full frame and splits off touches', () => {
    expect(images.map((e) => `${e.type}@${e.t}`)).toEqual(['frame@10', 'patch@20', 'patch@30', 'frame@40', 'patch@50']);
    expect(touches).toEqual([{ t: 12, x: 20, y: 40, phase: 'began' }]);
  });

  it('draws the last full image and the patches after it', () => {
    expect(drawListAt(images, 5)).toEqual([]);
    expect(drawListAt(images, 25).map((e) => e.t)).toEqual([10, 20]);
    expect(drawListAt(images, 45).map((e) => e.t)).toEqual([40]);
    expect(drawListAt(images, 99).map((e) => e.t)).toEqual([40, 50]);
    expect(frameAt(images, 35)?.t).toBe(10);
  });

  it('shows a touch for half a second', () => {
    expect(touchesAt(touches, 12)).toHaveLength(1);
    expect(touchesAt(touches, 511)).toHaveLength(1);
    expect(touchesAt(touches, 512)).toHaveLength(0);
    expect(touchesAt(touches, 11)).toHaveLength(0);
  });
});

describe('ouo-video/1', () => {
  const body = (header: object, mp4: number[]) => {
    const h = new TextEncoder().encode(JSON.stringify(header) + '\n');
    const out = new Uint8Array(h.length + mp4.length);
    out.set(h);
    out.set(mp4, h.length);
    return out.buffer;
  };
  const header = { t: 1000, type: 'video', end: 6000, w: 402, h: 874, scale: 1, fps: 1, frames: 5, mp4: 3 };

  it('splits the header line from the mp4 bytes', () => {
    const seg = parseVideoChunk(body(header, [1, 2, 3]));
    expect(seg.header.w).toBe(402);
    expect(Array.from(seg.mp4)).toEqual([1, 2, 3]);
  });

  it('rejects a body whose length disagrees with the header', () => {
    expect(() => parseVideoChunk(body(header, [1, 2]))).toThrow(/3 bytes/);
    expect(() => parseVideoChunk(new TextEncoder().encode('no newline').buffer)).toThrow(/header/);
  });

  it('finds the segment for a time, and gaps between segments', () => {
    const segs = [1000, 8000].map((t) => ({ header: { ...header, t, end: t + 5000 }, mp4: new Uint8Array() }) as VideoSegment);
    expect(segmentAt(segs, 500)).toEqual({ index: 0, inside: false });
    expect(segmentAt(segs, 3000)).toEqual({ index: 0, inside: true });
    expect(segmentAt(segs, 7000)).toEqual({ index: 0, inside: false });
    expect(segmentAt(segs, 9000)).toEqual({ index: 1, inside: true });
    expect(segmentAt([], 1)).toEqual({ index: -1, inside: false });
  });
});
