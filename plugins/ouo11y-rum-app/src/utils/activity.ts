import type { TimelineEvent } from '../api/types';
import { parseTs } from './format';
import { isTapEvent, type ReplayTap } from './taps';

/** Groups of the replay's activity list (like the tabs of Sentry's breadcrumb panel). */
export type ActivityCategory = 'tap' | 'navigation' | 'network' | 'error' | 'log' | 'other';

/** One row of the activity list beside a replay: a timeline event, or a tap. */
export interface ActivityItem {
  key: string;
  /** Epoch ms. */
  ts: number;
  /** Milliseconds from the replay start (negative before it). */
  offsetMs: number;
  category: ActivityCategory;
  /** True for errors, crashes, failed requests and error-level logs (shown under "Errors" too). */
  isError: boolean;
  event?: TimelineEvent;
  tap?: ReplayTap;
}

const ERROR_LEVELS = new Set(['error', 'fatal']);

export function activityCategory(ev: TimelineEvent): ActivityCategory {
  switch (ev.type) {
    case 'exception':
      return 'error';
    case 'http.request.failed':
      return 'network';
    case 'navigation':
      return 'navigation';
    case 'custom':
      switch (ev.name) {
        case 'ui.tap':
        case 'ouo.rage_click':
        case 'ouo.dead_click':
          return 'tap';
        case 'http.request':
          return 'network';
        case 'log':
        case 'console':
        case 'breadcrumb':
        case 'sentry.message':
          return 'log';
        default:
          return 'other';
      }
    default:
      return 'other';
  }
}

/**
 * The activity list of a replay: every timeline event plus the taps, sorted by time. With `taps`
 * (`buildTaps`), the timeline's `ui.tap` events are replaced by the merged taps, so one tap is one
 * row that has both the component and the position, and a touch without a breadcrumb has a row too.
 */
export function buildActivity(
  timeline: readonly TimelineEvent[],
  replayStart: number,
  taps?: readonly ReplayTap[]
): ActivityItem[] {
  const out: ActivityItem[] = [];
  timeline.forEach((ev, i) => {
    if (taps && isTapEvent(ev)) {
      return;
    }
    const ts = parseTs(ev.ts);
    if (Number.isNaN(ts)) {
      return;
    }
    const category = activityCategory(ev);
    out.push({
      key: `ev-${i}`,
      ts,
      offsetMs: ts - replayStart,
      category,
      isError:
        category === 'error' ||
        ev.type === 'http.request.failed' ||
        (category === 'log' && ERROR_LEVELS.has(ev.attrs.ouo_sentry_level ?? '')),
      event: ev,
    });
  });
  taps?.forEach((tap, i) => {
    out.push({ key: `tap-${i}`, ts: tap.ts, offsetMs: tap.ts - replayStart, category: 'tap', isError: false, tap });
  });
  // Stable: equal timestamps keep timeline order, taps after the events of the same instant.
  return out.sort((a, b) => a.ts - b.ts);
}

export type ActivityFilter = 'all' | 'tap' | 'navigation' | 'network' | 'error' | 'log';

export function matchesFilter(item: ActivityItem, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'error':
      return item.isError;
    default:
      return item.category === filter;
  }
}

/** Index of the latest item at or before `currentMs` (replay offset), -1 when none. Items are sorted. */
export function activeActivityIndex(items: readonly ActivityItem[], currentMs: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].offsetMs <= currentMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
