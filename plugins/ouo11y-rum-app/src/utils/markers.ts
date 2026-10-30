import type { TimelineEvent, TimelineType } from '../api/types';
import { isFeedbackEvent } from './feedback';
import { parseTs } from './format';
import { isTapEvent, tapLabel, type ReplayTap } from './taps';

export type MarkerKind = 'error' | 'crash' | 'failed_request' | 'navigation' | 'tap' | 'feedback';

export interface ReplayMarker {
  /** Index into the timeline array; -1 for a tap known only from a recorded touch. */
  index: number;
  /** Unique key among the markers. */
  key: string;
  kind: MarkerKind;
  /** Milliseconds from replay start (may be negative when the event precedes the first rrweb event). */
  offsetMs: number;
  /** Position on the bar, 0..100, clamped. */
  leftPct: number;
  label: string;
}

/** Position of an instant on a bar spanning [start, start + duration], clamped to 0..100. */
export function markerPosition(ts: number, start: number, durationMs: number): number {
  if (!Number.isFinite(ts) || !Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  const pct = ((ts - start) / durationMs) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Offset into the replay to seek to for a timeline event; never negative, never past the end. */
export function seekOffset(ts: number, start: number, durationMs: number): number {
  if (!Number.isFinite(ts) || !Number.isFinite(start)) {
    return 0;
  }
  const offset = ts - start;
  const max = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return Math.min(max, Math.max(0, offset));
}

export function markerKind(ev: TimelineEvent): MarkerKind | null {
  const type = ev.type as TimelineType;
  switch (type) {
    case 'exception':
      return ev.attrs?.ouo_exception_fatal === 'true' ? 'crash' : 'error';
    case 'http.request.failed':
      return 'failed_request';
    case 'navigation':
      return 'navigation';
    case 'custom':
      return isTapEvent(ev) ? 'tap' : isFeedbackEvent(ev) ? 'feedback' : null;
    default:
      return null;
  }
}

export function markerLabel(ev: TimelineEvent): string {
  const a = ev.attrs ?? {};
  switch (ev.type) {
    case 'exception':
      return `${a.ouo_exception_fatal === 'true' ? 'Fatal' : 'Error'}: ${a.exception_type ?? ''} ${a.exception_message ?? ''}`.trim();
    case 'http.request.failed':
      return `${a.http_request_method ?? ''} ${a.url_full ?? a.url_path ?? ''} → ${a.http_response_status_code ?? 'failed'}`.trim();
    case 'navigation':
      return `Navigation ${a.url_path ?? a.url_full ?? ''}`.trim();
    case 'custom':
      if (isTapEvent(ev)) {
        return `Tap ${a.ouo_ui_target ?? ''}`.trim();
      }
      if (isFeedbackEvent(ev)) {
        return `Feedback: ${a.ouo_feedback_message ?? ''}`.trim();
      }
      return ev.name;
    default:
      return ev.name;
  }
}

/**
 * Builds replay markers (errors, failed requests, navigations, taps, feedback) from a timeline. With `taps`
 * (`buildTaps` of a video replay's touches and the timeline), taps come from that list instead of
 * the timeline's `ui.tap` events, so a touch without a breadcrumb gets a marker too. Taps are
 * listed first so the other kinds are drawn on top of them.
 */
export function buildMarkers(
  timeline: TimelineEvent[],
  replayStart: number,
  durationMs: number,
  taps?: readonly ReplayTap[]
): ReplayMarker[] {
  const out: ReplayMarker[] = [];
  taps?.forEach((tap, i) => {
    out.push({
      index: tap.timelineIndex ?? -1,
      key: `tap-${i}`,
      kind: 'tap',
      offsetMs: tap.ts - replayStart,
      leftPct: markerPosition(tap.ts, replayStart, durationMs),
      label: tap.target ? `Tap ${tap.target}` : tapLabel(tap),
    });
  });
  const tapEvents: ReplayMarker[] = [];
  timeline.forEach((ev, index) => {
    const kind = markerKind(ev);
    if (!kind || (kind === 'tap' && taps)) {
      return;
    }
    const ts = parseTs(ev.ts);
    if (Number.isNaN(ts)) {
      return;
    }
    const marker = {
      index,
      key: `ev-${index}`,
      kind,
      offsetMs: ts - replayStart,
      leftPct: markerPosition(ts, replayStart, durationMs),
      label: markerLabel(ev),
    };
    (kind === 'tap' ? tapEvents : out).push(marker);
  });
  return [...tapEvents, ...out];
}

/**
 * Index of the latest timeline event whose timestamp is <= replayStart + currentMs,
 * or -1 when none. Timeline is assumed sorted by ts ascending.
 */
export function latestEventIndex(timeline: TimelineEvent[], replayStart: number, currentMs: number): number {
  const cursor = replayStart + currentMs;
  let latest = -1;
  for (let i = 0; i < timeline.length; i++) {
    const ts = parseTs(timeline[i].ts);
    if (Number.isNaN(ts)) {
      continue;
    }
    if (ts <= cursor) {
      latest = i;
    } else {
      break;
    }
  }
  return latest;
}

/** Replay start and duration from rrweb events (first and last event timestamps). */
export function replayBounds(events: Array<{ timestamp: number }>): { start: number; durationMs: number } {
  if (!events.length) {
    return { start: NaN, durationMs: 0 };
  }
  const start = events[0].timestamp;
  const end = events[events.length - 1].timestamp;
  return { start, durationMs: Math.max(0, end - start) };
}
