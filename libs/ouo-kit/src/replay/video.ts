// The `ouo-video/1` body and timeline (docs/specs/mobile-replay.md, "`ouo-video/1`: video
// segments over OTLP"). One chunk is one segment: a line of JSON, a newline, then the mp4.
import type { ChunkEntry } from '../manifest';

/** A touch made during a segment, in points of the window. */
export interface VideoTouch {
  /** Epoch ms. */
  t: number;
  x: number;
  y: number;
  /** `began`, `moved` or `ended`. */
  phase: string;
}

/** The header line of an `ouo-video/1` chunk. */
export interface VideoHeader {
  /** Epoch ms of the first frame. */
  t: number;
  /** Epoch ms of the segment's end. */
  end: number;
  /** Video size in pixels. */
  w: number;
  h: number;
  /** Video pixels per point of the window. */
  scale: number;
  fps: number;
  frames: number;
  /** Byte length of the mp4 after the newline. */
  mp4: number;
  touches: VideoTouch[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Splits an `ouo-video/1` chunk into its header and its mp4 bytes. Throws, with a message fit to
 * show, when there is no header line, the header is not JSON or lacks a field the player needs,
 * or the mp4 is not the length the header says.
 */
export function parseVideoChunk(body: ArrayBuffer): { header: VideoHeader; mp4: Uint8Array } {
  const bytes = new Uint8Array(body);
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) {
    throw new Error('no header line (the chunk has no newline)');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl))) as Record<string, unknown>;
  } catch {
    throw new Error('the header line is not JSON');
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('the header line is not a JSON object');
  }
  for (const key of ['t', 'end', 'w', 'h', 'mp4'] as const) {
    if (!finite(raw[key])) {
      throw new Error(`the header has no numeric "${key}"`);
    }
  }
  const mp4 = bytes.subarray(nl + 1);
  if (mp4.byteLength !== raw.mp4) {
    throw new Error(`the header says ${raw.mp4} mp4 bytes, the chunk holds ${mp4.byteLength}`);
  }
  const touches = Array.isArray(raw.touches)
    ? (raw.touches as Partial<VideoTouch>[]).filter((p): p is VideoTouch => finite(p?.t) && finite(p?.x) && finite(p?.y))
    : [];
  const header: VideoHeader = {
    t: raw.t as number,
    end: raw.end as number,
    w: raw.w as number,
    h: raw.h as number,
    scale: finite(raw.scale) && raw.scale > 0 ? raw.scale : 1,
    fps: finite(raw.fps) && raw.fps > 0 ? raw.fps : 1,
    frames: finite(raw.frames) ? raw.frames : 0,
    mp4: mp4.byteLength,
    touches,
  };
  return { header, mp4 };
}

/** One segment on the player's timeline. */
export interface VideoSegment {
  chunk: ChunkEntry;
  /** Where the segment starts on the timeline, in ms. */
  offset: number;
  /** Its length in ms, from the chunk's `start_time` and `end_time`. */
  duration: number;
}

/**
 * Lays the held segments of a stream back to back in sequence order: a gap in the sequence
 * numbers takes no time, play goes straight on to the next held segment.
 */
export function videoTimeline(chunks: ChunkEntry[]): { segments: VideoSegment[]; total: number } {
  const segments: VideoSegment[] = [];
  let offset = 0;
  for (const chunk of [...chunks].sort((a, b) => a.sequence - b.sequence)) {
    const duration = Math.max(1, chunk.end_time - chunk.start_time);
    segments.push({ chunk, offset, duration });
    offset += duration;
  }
  return { segments, total: offset };
}

/** The segment under a timeline offset, and the offset inside it; past the end is the last one's end. */
export function locateSegment(segments: VideoSegment[], offsetMs: number): { index: number; local: number } {
  if (!segments.length) {
    return { index: -1, local: 0 };
  }
  const at = Math.max(0, offsetMs);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (at < s.offset + s.duration) {
      return { index: i, local: at - s.offset };
    }
  }
  const last = segments.length - 1;
  return { index: last, local: segments[last].duration };
}

/** How long a touch stays drawn: one frame at the 1 frame/s the recorders use. */
export const TOUCH_WINDOW_MS = 1000;

/** The touches to draw when the video is `localMs` into the segment. */
export function touchesAt(header: VideoHeader, localMs: number, windowMs = TOUCH_WINDOW_MS): VideoTouch[] {
  return header.touches.filter((p) => {
    const age = localMs - (p.t - header.t);
    return age >= 0 && age < windowMs;
  });
}
