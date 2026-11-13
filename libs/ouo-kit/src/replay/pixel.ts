// The pixel formats of the mobile SDKs (docs/specs/mobile-replay.md):
//
// - `ouo-frames/3`: newline-delimited JSON events, gzip on the wire (the BFF decompresses):
//   {"t","type":"frame","w","h","scale","reason","jpeg"}  a full image (base64 JPEG)
//   {"t","type":"patch","reason","patches":[{x,y,w,h,jpeg}]}  rectangles over the last image
//   {"t","type":"touch","x","y","phase"}  in points; drawn at (x*scale, y*scale)
// - `ouo-video/1`: one chunk is one segment: a JSON header line, a newline, then `mp4` bytes.

export interface FrameEvent {
  t: number;
  type: 'frame';
  w: number;
  h: number;
  scale: number;
  jpeg: string;
}
export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  jpeg: string;
}
export interface PatchEvent {
  t: number;
  type: 'patch';
  patches: Patch[];
}
export interface Touch {
  t: number;
  x: number;
  y: number;
  phase: string;
}
export type PixelEvent = FrameEvent | PatchEvent | (Touch & { type: 'touch' });

/** Splits parsed frames events into images (frames and patches, in time order) and touches. */
export function splitFrames(events: unknown[]): { images: Array<FrameEvent | PatchEvent>; touches: Touch[] } {
  const images: Array<FrameEvent | PatchEvent> = [];
  const touches: Touch[] = [];
  for (const e of events as PixelEvent[]) {
    if (!e || typeof e.t !== 'number') {
      continue;
    }
    if (e.type === 'frame' && typeof e.jpeg === 'string') {
      images.push(e);
    } else if (e.type === 'patch' && Array.isArray(e.patches)) {
      images.push(e);
    } else if (e.type === 'touch') {
      touches.push({ t: e.t, x: e.x, y: e.y, phase: e.phase });
    }
  }
  images.sort((a, b) => a.t - b.t);
  touches.sort((a, b) => a.t - b.t);
  // A patch before the first full image has nothing to draw on.
  const first = images.findIndex((e) => e.type === 'frame');
  return { images: first < 0 ? [] : images.slice(first), touches };
}

/**
 * What to draw for time `t`: the latest full image at or before `t`, then the patches after
 * it up to `t`, in order. Empty before the first image.
 */
export function drawListAt(images: Array<FrameEvent | PatchEvent>, t: number): Array<FrameEvent | PatchEvent> {
  let last = -1;
  for (let i = 0; i < images.length && images[i].t <= t; i++) {
    last = i;
  }
  if (last < 0) {
    return [];
  }
  let base = last;
  while (base >= 0 && images[base].type !== 'frame') {
    base--;
  }
  return base < 0 ? [] : images.slice(base, last + 1);
}

/** The full image in force at `t` (its size and scale set the canvas). */
export function frameAt(images: Array<FrameEvent | PatchEvent>, t: number): FrameEvent | undefined {
  const list = drawListAt(images, t);
  return list[0] as FrameEvent | undefined;
}

/** Touches to show at `t`: those within the last `windowMs`, newest last. */
export function touchesAt(touches: Touch[], t: number, windowMs = 500): Touch[] {
  return touches.filter((x) => x.t <= t && t - x.t < windowMs);
}

export interface VideoHeader {
  t: number;
  type: 'video';
  end: number;
  w: number;
  h: number;
  scale: number;
  fps: number;
  frames: number;
  mp4: number;
  touches?: Touch[];
}
export interface VideoSegment {
  header: VideoHeader;
  mp4: Uint8Array;
}

/** Parses one `ouo-video/1` chunk body. Throws on a body that is not one. */
export function parseVideoChunk(body: ArrayBuffer): VideoSegment {
  const bytes = new Uint8Array(body);
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) {
    throw new Error('ouo-video/1: no header line');
  }
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl))) as VideoHeader;
  if (header.type !== 'video' || typeof header.t !== 'number' || typeof header.end !== 'number' || typeof header.mp4 !== 'number') {
    throw new Error('ouo-video/1: the header is not a video header');
  }
  const mp4 = bytes.subarray(nl + 1);
  if (mp4.length !== header.mp4) {
    throw new Error(`ouo-video/1: header says ${header.mp4} bytes of mp4, body has ${mp4.length}`);
  }
  return { header, mp4 };
}

/** The segment playing at `t` (segments sorted by start), or the last one that ended before it. */
export function segmentAt(segments: VideoSegment[], t: number): { index: number; inside: boolean } {
  let index = -1;
  for (let i = 0; i < segments.length && segments[i].header.t <= t; i++) {
    index = i;
  }
  if (index < 0) {
    return { index: segments.length ? 0 : -1, inside: false };
  }
  return { index, inside: t < segments[index].header.end };
}
