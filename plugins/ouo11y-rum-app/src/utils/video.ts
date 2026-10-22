import type { VideoManifest, VideoSegment } from '../api/types';

/**
 * Where the global replay clock falls in a video replay (ADR-0008, kind `video`).
 *
 * - `index`: the segment to show, -1 when there are no segments.
 * - `offsetMs`: offset into that segment's media, never negative; it may exceed the segment's
 *   duration in a gap, the player clamps it to the media length so the last frame stays.
 * - `inGap`: no segment covers the instant. Before the first segment the first frame is shown,
 *   between segments (or after the last) the last frame of the previous segment.
 */
export interface SegmentPosition {
  index: number;
  offsetMs: number;
  inGap: boolean;
}

/** Media length of a segment: `duration_ms`, or `ended_at - started_at` when that is missing. */
export function segmentDurationMs(seg: Pick<VideoSegment, 'duration_ms' | 'started_at' | 'ended_at'>): number {
  if (Number.isFinite(seg.duration_ms) && seg.duration_ms > 0) {
    return seg.duration_ms;
  }
  const span = seg.ended_at - seg.started_at;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

/** Segments in playback order (seq ascending); rum-api already sorts them, this is defensive. */
export function orderSegments(segments: readonly VideoSegment[] | undefined): VideoSegment[] {
  return [...(segments ?? [])].sort((a, b) => a.seq - b.seq);
}

/**
 * Maps an instant (epoch ms) to a segment and an offset into it. Segments are in seq order with
 * non-decreasing `started_at`; the latest segment that started at or before `ts` wins.
 */
export function locateSegment(
  segments: ReadonlyArray<Pick<VideoSegment, 'started_at' | 'ended_at' | 'duration_ms'>>,
  ts: number
): SegmentPosition {
  if (segments.length === 0) {
    return { index: -1, offsetMs: 0, inGap: true };
  }
  if (!Number.isFinite(ts) || ts < segments[0].started_at) {
    return { index: 0, offsetMs: 0, inGap: true };
  }
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].started_at <= ts) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const seg = segments[lo];
  const offsetMs = ts - seg.started_at;
  return { index: lo, offsetMs, inGap: offsetMs >= segmentDurationMs(seg) };
}

/** Global replay offset (ms from `startTs`) at which a segment starts; used to step between segments. */
export function segmentStartOffset(seg: Pick<VideoSegment, 'started_at'>, startTs: number): number {
  return Math.max(0, seg.started_at - startTs);
}

/**
 * `currentTime` (seconds) for an offset into a segment. Clamped to the decoded media length when
 * it is known, a millisecond short of the end so browsers keep painting the last frame.
 */
export function mediaTimeSec(offsetMs: number, mediaDurationSec: number): number {
  const sec = Number.isFinite(offsetMs) ? Math.max(0, offsetMs) / 1000 : 0;
  if (Number.isFinite(mediaDurationSec) && mediaDurationSec > 0) {
    return Math.min(sec, Math.max(0, mediaDurationSec - 0.001));
  }
  return sec;
}

/**
 * Segment indices to keep mounted as `<video>` elements: the one under the cursor and both
 * neighbours, so playing on into the next segment or stepping back has a decoded frame ready, plus
 * `hold` (the segment still on screen while the one under the cursor loads, see
 * {@link paintedSegmentIndex}). Sorted, without duplicates.
 */
export function mountedSegmentIndices(count: number, index: number, hold = -1): number[] {
  if (count <= 0 || index < 0) {
    return [];
  }
  const current = Math.min(index, count - 1);
  const out = new Set<number>();
  for (const i of [current - 1, current, current + 1, hold]) {
    if (i >= 0 && i < count) {
      out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The segment whose `<video>` is painted (F4): the one under the cursor once it can show the
 * cursor's frame; until then the one painted before (`previous`), so a seek to a segment that is
 * not loaded yet keeps the last frame instead of a black stage. With nothing painted before, the
 * segment under the cursor (its loading notice shows).
 */
export function paintedSegmentIndex(active: number, activeCanPaint: boolean, previous: number, count: number): number {
  if (active < 0) {
    return -1;
  }
  if (activeCanPaint || previous < 0 || previous >= count) {
    return active;
  }
  return previous;
}

/**
 * Replay start and duration of a video replay: the manifest's `started_at`/`ended_at`, falling back
 * to the first segment's start and the last segment's end when a bound is missing.
 */
export function videoBounds(manifest: Pick<VideoManifest, 'started_at' | 'ended_at' | 'segments'> | undefined): {
  start: number;
  durationMs: number;
} {
  if (!manifest) {
    return { start: NaN, durationMs: 0 };
  }
  const segments = orderSegments(manifest.segments);
  let start = manifest.started_at;
  let end = manifest.ended_at;
  if (!Number.isFinite(start) && segments.length) {
    start = segments[0].started_at;
  }
  if (!Number.isFinite(end) && segments.length) {
    const last = segments[segments.length - 1];
    end = Math.max(last.ended_at, last.started_at + segmentDurationMs(last));
  }
  if (!Number.isFinite(start)) {
    return { start: NaN, durationMs: 0 };
  }
  return { start, durationMs: Math.max(0, (Number.isFinite(end) ? end : start) - start) };
}

/** Total encoded frames over all segments. */
export function totalFrames(segments: ReadonlyArray<Pick<VideoSegment, 'frame_count'>>): number {
  return segments.reduce((n, s) => n + (Number.isFinite(s.frame_count) && s.frame_count > 0 ? s.frame_count : 0), 0);
}

/**
 * Step for the arrow keys: one encoded frame of the segment on screen (`duration / frame_count`,
 * about 1 s for Sentry's ~1 fps), at least 100 ms, 1 s when the frame count is unknown.
 */
export function frameStepMs(
  seg: Pick<VideoSegment, 'duration_ms' | 'started_at' | 'ended_at' | 'frame_count'> | undefined
): number {
  if (!seg || !(seg.frame_count > 0)) {
    return 1000;
  }
  const dur = segmentDurationMs(seg);
  return dur > 0 ? Math.max(100, dur / seg.frame_count) : 1000;
}

/** The part of `HTMLVideoElement` the player drives; a plain object in tests. */
export interface MediaLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly error: { code: number; message?: string } | null;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: the frame at `currentTime` can be painted. */
export const HAVE_CURRENT_DATA = 2;

/** While playing, the element runs on its own clock; it is re-seeked only past this drift. */
export const DRIFT_SEC = 0.25;
/** While paused or in a gap, the element is seeked to the cursor past this difference. */
export const STILL_SEC = 0.02;

/**
 * Makes one segment's `<video>` follow the replay clock: playing at `speed` while the clock runs
 * inside the segment, otherwise paused on the cursor's frame (the last frame in a gap after it).
 * Seeks only when the element is not already seeking, and never restarts a segment that ended.
 */
export function syncMediaElement(el: MediaLike, pos: SegmentPosition, playing: boolean, speed: number): void {
  if (el.playbackRate !== speed) {
    el.playbackRate = speed;
  }
  const target = mediaTimeSec(pos.offsetMs, el.duration);
  const run = playing && !pos.inGap && !el.error;
  const tolerance = run ? DRIFT_SEC : STILL_SEC;
  if (!el.seeking && Math.abs(el.currentTime - target) > tolerance) {
    el.currentTime = target;
  }
  if (!run) {
    if (!el.paused) {
      el.pause();
    }
    return;
  }
  if (el.paused && !el.ended) {
    const p = el.play();
    // Autoplay rejections and aborted loads are not errors for a muted replay; the clock goes on.
    if (p && typeof p.catch === 'function') {
      p.catch(() => undefined);
    }
  }
}

/** True while the segment under the cursor is still loading, so the clock should wait for it. */
export function mediaPending(el: Pick<MediaLike, 'readyState' | 'error'> | undefined, pos: SegmentPosition): boolean {
  return Boolean(el && !pos.inGap && !el.error && el.readyState < HAVE_CURRENT_DATA);
}

/** Human text for a `MediaError` code. */
export function mediaErrorText(err: { code: number; message?: string } | null | undefined): string {
  switch (err?.code) {
    case 1:
      return 'loading was aborted';
    case 2:
      return 'network error while loading the segment';
    case 3:
      return 'the segment could not be decoded';
    case 4:
      return 'the segment is not a playable mp4';
    default:
      return err?.message || 'unknown media error';
  }
}
