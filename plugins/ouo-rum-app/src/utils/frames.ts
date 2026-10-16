import type { ReplayFramesResponse, ReplayKind, ReplayMeta, ReplayTouch, SessionRecord } from '../api/types';
import { isReplayKind } from './format';

/** How long a touch indicator stays visible after the touch instant. */
export const TOUCH_WINDOW_MS = 500;

/**
 * Index of the frame to show at `ts`: the latest frame whose `ts` is <= the instant.
 * Before the first frame the first one is shown; after the last frame the last one stays.
 * Frames are assumed sorted by `ts` ascending (rum-api concatenates chunks in seq order).
 */
export function frameIndexAt(frames: ReadonlyArray<{ ts: number }>, ts: number): number {
  if (frames.length === 0) {
    return -1;
  }
  if (!Number.isFinite(ts) || ts <= frames[0].ts) {
    return 0;
  }
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].ts <= ts) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export interface VisibleTouch {
  touch: ReplayTouch;
  /** 0..1 fraction of the viewport. */
  left: number;
  top: number;
  /** 1 at the touch instant, 0 at the end of the window. */
  opacity: number;
}

/**
 * Touches that happened within `windowMs` before `ts` (inclusive of `ts`), with a position
 * normalised to the viewport and an opacity that fades linearly to 0 over the window.
 * Touches with coordinates outside the viewport are dropped.
 */
export function visibleTouches(
  touches: readonly ReplayTouch[],
  viewport: { width: number; height: number },
  ts: number,
  windowMs = TOUCH_WINDOW_MS
): VisibleTouch[] {
  if (!viewport.width || !viewport.height || !Number.isFinite(ts)) {
    return [];
  }
  const out: VisibleTouch[] = [];
  for (const touch of touches) {
    const age = ts - touch.ts;
    if (age < 0 || age > windowMs) {
      continue;
    }
    const left = touch.x / viewport.width;
    const top = touch.y / viewport.height;
    if (left < 0 || left > 1 || top < 0 || top > 1) {
      continue;
    }
    out.push({ touch, left, top, opacity: 1 - age / windowMs });
  }
  return out;
}

/** Replay start and duration for a frames replay: `started_at`/`ended_at` of the response. */
export function framesBounds(resp: Pick<ReplayFramesResponse, 'started_at' | 'ended_at' | 'frames'> | undefined): {
  start: number;
  durationMs: number;
} {
  if (!resp) {
    return { start: NaN, durationMs: 0 };
  }
  let start = resp.started_at;
  let end = resp.ended_at;
  // Defensive: a chunk writer may leave the bounds unset; fall back to the frames themselves.
  if (!Number.isFinite(start) && resp.frames.length) {
    start = resp.frames[0].ts;
  }
  if (!Number.isFinite(end) && resp.frames.length) {
    end = resp.frames[resp.frames.length - 1].ts;
  }
  if (!Number.isFinite(start)) {
    return { start: NaN, durationMs: 0 };
  }
  return { start, durationMs: Math.max(0, (Number.isFinite(end) ? end : start) - start) };
}

/** Clamps a scrubber offset into `[0, durationMs]`. */
export function clampOffset(offsetMs: number, durationMs: number): number {
  if (!Number.isFinite(offsetMs)) {
    return 0;
  }
  const max = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return Math.min(max, Math.max(0, offsetMs));
}

/**
 * Which renderer a session needs: `replay_kind` on the record wins; otherwise the replay meta's
 * `kind`; a meta without `kind` predates Phase 7 and is rrweb. `undefined` means "not known
 * yet" (meta still loading), `null` means "no replay".
 */
export function replayRenderer(
  session: Pick<SessionRecord, 'has_replay' | 'replay_kind'> | undefined,
  meta: Pick<ReplayMeta, 'kind'> | undefined
): ReplayKind | null | undefined {
  if (!session) {
    return undefined;
  }
  if (!session.has_replay) {
    return null;
  }
  if (isReplayKind(session.replay_kind)) {
    return session.replay_kind;
  }
  if (!meta) {
    return undefined;
  }
  return meta.kind === 'frames' || meta.kind === 'video' ? meta.kind : 'rrweb';
}

/** Index of the frame before / after the current one, clamped (used by arrow-key stepping). */
export function stepFrameIndex(frameCount: number, current: number, delta: -1 | 1): number {
  if (frameCount <= 0) {
    return -1;
  }
  return Math.min(frameCount - 1, Math.max(0, current + delta));
}
