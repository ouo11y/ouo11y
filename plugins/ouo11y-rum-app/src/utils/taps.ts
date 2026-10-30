import type { ReplayTouch, TimelineEvent } from '../api/types';
import { parseTs } from './format';

/**
 * One user tap in a replay, merged from the two places a Sentry-sourced replay records it
 * (docs/specs/sentry-bridge.md sections 9 and 9a):
 *
 * - the replay recording's touch events (rrweb incremental source 2 / 6), stored as the video
 *   manifest's `touches`: a position in the video's pixel space, but no target;
 * - the `ui.tap` breadcrumb (a timeline event): the touched component, but no position.
 *
 * A tap has a position, a target, or both.
 */
export interface ReplayTap {
  /** Epoch ms: the touch start when there is one, else the breadcrumb time. */
  ts: number;
  /** Position in the viewport's space (video pixels), when a touch was recorded. */
  x?: number;
  y?: number;
  /** True when the finger moved more than {@link DRAG_PX} before lifting (a scroll or swipe). */
  drag?: boolean;
  /** Touched component (`ouo_ui_target`) and component path (`ouo_ui_path`) from the breadcrumb. */
  target?: string;
  path?: string;
  /** From the ouo SDKs (spec C6): `ouo_ui_gesture`, `ouo_ui_view_type`, `app_screen_name`. */
  gesture?: string;
  viewType?: string;
  screen?: string;
  /** Index of the `ui.tap` event in the timeline, when the tap has one. */
  timelineIndex?: number;
}

/**
 * A `ui.tap` breadcrumb is paired with the touch that started at most this far from it. Sentry
 * React Native writes the breadcrumb when the touch ends (measured: 25 to 90 ms after the touch start
 * for a tap); a long press can be later, so the window is generous.
 */
export const TAP_MATCH_MS = 1000;

/** Movement (viewport units) from the touch start beyond which a gesture is a drag. */
export const DRAG_PX = 24;

export const isTapEvent = (ev: TimelineEvent) => ev.type === 'custom' && ev.name === 'ui.tap';

/** A touch this long after the previous one of an open gesture starts a new gesture (a lost `ended`). */
export const GESTURE_GAP_MS = 1000;

interface Gesture {
  ts: number;
  last: number;
  x: number;
  y: number;
  drag: boolean;
}

/**
 * Groups touches into gestures: a `began` (or any touch while none is open, or after a pause of
 * {@link GESTURE_GAP_MS}) up to its `ended`.
 */
function gestures(touches: readonly ReplayTouch[]): Gesture[] {
  const sorted = [...touches].filter((t) => Number.isFinite(t.ts)).sort((a, b) => a.ts - b.ts);
  const out: Gesture[] = [];
  let open: Gesture | null = null;
  for (const t of sorted) {
    if (t.phase === 'began' || !open || t.ts - open.last > GESTURE_GAP_MS) {
      open = { ts: t.ts, last: t.ts, x: t.x, y: t.y, drag: false };
      out.push(open);
    } else if (Math.hypot(t.x - open.x, t.y - open.y) > DRAG_PX) {
      open.drag = true;
    }
    open.last = t.ts;
    if (t.phase === 'ended' || t.phase === 'cancelled') {
      open = null;
    }
  }
  return out;
}

/**
 * Taps of a replay: every gesture of `touches` and every `ui.tap` event of `timeline`, a breadcrumb
 * paired with the nearest unpaired gesture within {@link TAP_MATCH_MS}. A breadcrumb without a touch
 * (the recording missed it, or the touch fell between two recorded segments) is still a tap, without
 * a position; a gesture without a breadcrumb (a touch on something with no label) is a tap without a
 * target. Sorted by time.
 */
export function buildTaps(touches: readonly ReplayTouch[], timeline: readonly TimelineEvent[]): ReplayTap[] {
  const gs = gestures(touches);
  const taps: ReplayTap[] = gs.map((g) => ({ ts: g.ts, x: g.x, y: g.y, drag: g.drag }));
  const paired = new Set<number>();
  timeline.forEach((ev, timelineIndex) => {
    if (!isTapEvent(ev)) {
      return;
    }
    const ts = parseTs(ev.ts);
    if (Number.isNaN(ts)) {
      return;
    }
    let best = -1;
    let bestDt = Infinity;
    gs.forEach((g, i) => {
      const dt = Math.abs(ts - g.ts);
      if (!paired.has(i) && dt <= TAP_MATCH_MS && dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    const named = {
      target: ev.attrs.ouo_ui_target || undefined,
      path: ev.attrs.ouo_ui_path || undefined,
      gesture: ev.attrs.ouo_ui_gesture || undefined,
      viewType: ev.attrs.ouo_ui_view_type || undefined,
      screen: ev.attrs.app_screen_name || undefined,
      timelineIndex,
    };
    if (best >= 0) {
      paired.add(best);
      Object.assign(taps[best], named);
    } else {
      taps.push({ ts, ...named });
    }
  });
  return taps.sort((a, b) => a.ts - b.ts);
}

const GESTURES: Record<string, string> = { tap: 'Tap', long_press: 'Long press', swipe: 'Swipe' };

/** The gesture of a tap as a word: the SDK's `ouo_ui_gesture`, else a swipe when the recorded touch moved. */
export const gestureTitle = (gesture?: string, drag?: boolean): string =>
  (gesture && GESTURES[gesture]) || (drag ? 'Swipe' : 'Tap');

/** What was touched and where, as a user step reads after its gesture: `add-to-cart (button) on Products` (spec C6). */
export function tapSubject(target?: string, viewType?: string, screen?: string): string {
  return [target, viewType && viewType !== target ? `(${viewType})` : '', screen ? `on ${screen}` : '']
    .filter(Boolean)
    .join(' ');
}

/** True when the tap has a position to draw. */
export const hasPosition = (t: ReplayTap): t is ReplayTap & { x: number; y: number } =>
  Number.isFinite(t.x) && Number.isFinite(t.y);

/** Short human label of a tap: its target, else "Tap at x, y", else "Tap". */
export function tapLabel(t: ReplayTap): string {
  if (t.target) {
    return t.target;
  }
  if (hasPosition(t)) {
    return `${t.drag ? 'Swipe' : 'Tap'} at ${Math.round(t.x)}, ${Math.round(t.y)}`;
  }
  return 'Tap';
}

export interface VisibleTap {
  tap: ReplayTap;
  /** 0..1 fraction of the viewport, when the tap has a position. */
  left?: number;
  top?: number;
  opacity: number;
}

/** How long a tap indicator stays on a video replay (Sentry records about 1 frame per second). */
export const TAP_WINDOW_MS = 1500;
/** The indicator is fully opaque this long, then fades out over the rest of the window. */
export const TAP_HOLD_MS = 1000;

/**
 * Taps on screen at `ts`: those that started within `windowMs` before it, fully opaque for
 * `holdMs`, then fading to 0 at the end of the window. A tap whose position is outside the viewport
 * is shown without a position (as a label) rather than dropped.
 */
export function visibleTaps(
  taps: readonly ReplayTap[],
  viewport: { width: number; height: number },
  ts: number,
  windowMs = TAP_WINDOW_MS,
  holdMs = TAP_HOLD_MS
): VisibleTap[] {
  if (!Number.isFinite(ts)) {
    return [];
  }
  const hold = Math.min(holdMs, windowMs);
  const out: VisibleTap[] = [];
  for (const tap of taps) {
    const age = ts - tap.ts;
    if (age < 0 || age > windowMs) {
      continue;
    }
    const opacity = age <= hold ? 1 : 1 - (age - hold) / Math.max(1, windowMs - hold);
    const v: VisibleTap = { tap, opacity };
    if (hasPosition(tap) && viewport.width > 0 && viewport.height > 0) {
      const left = tap.x / viewport.width;
      const top = tap.y / viewport.height;
      if (left >= 0 && left <= 1 && top >= 0 && top <= 1) {
        v.left = left;
        v.top = top;
      }
    }
    out.push(v);
  }
  return out;
}
