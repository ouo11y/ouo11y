import type { TimelineEvent } from '../api/types';
import { parseTs } from './format';

/** How many steps before a feedback are listed (docs/specs/mobile-sdk.md C10). */
export const LAST_EVENTS = 20;

/** One step before a feedback: an `ouo.last_events` entry, or a timeline event (`event` set). */
export interface FeedbackStep {
  ts: number;
  name: string;
  body: string;
  event?: TimelineEvent;
}

/** A `feedback` record of the session (C10), from the ouo SDK or the Sentry bridge. */
export interface FeedbackItem {
  key: string;
  /** Epoch ms. */
  ts: number;
  message: string;
  contact?: string;
  /** `ouo.feedback.screenshot`: the replay was asked for a frame of the screen. */
  screenshot: boolean;
  /** Oldest first: the record's `ouo.last_events`, else the session's timeline events before it. */
  steps: FeedbackStep[];
}

export function isFeedbackEvent(ev: TimelineEvent): boolean {
  return ev.name === 'feedback';
}

/** `ouo.last_events` (a JSON array of `{ts, name, body}`); undefined when absent or not that shape. */
export function parseLastEvents(raw: string | undefined): FeedbackStep[] | undefined {
  if (!raw) {
    return undefined;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(v)) {
    return undefined;
  }
  const steps: FeedbackStep[] = [];
  for (const e of v) {
    if (e && typeof e === 'object' && typeof e.ts === 'number' && typeof e.name === 'string') {
      steps.push({ ts: e.ts, name: e.name, body: typeof e.body === 'string' ? e.body : '' });
    }
  }
  return steps;
}

/**
 * The session's feedback, oldest first. Each carries the steps before it: what the record says
 * (`ouo.last_events`, the ouo SDK), else the last LAST_EVENTS timeline events up to its time
 * (the Sentry bridge, whose feedback breadcrumbs are timeline events).
 */
export function buildFeedback(timeline: readonly TimelineEvent[]): FeedbackItem[] {
  const out: FeedbackItem[] = [];
  timeline.forEach((ev, i) => {
    if (!isFeedbackEvent(ev)) {
      return;
    }
    const ts = parseTs(ev.clampedFrom ?? ev.ts);
    const message = ev.attrs.ouo_feedback_message ?? '';
    if (Number.isNaN(ts) || !message) {
      return;
    }
    const steps =
      parseLastEvents(ev.attrs.ouo_last_events) ??
      timeline
        .filter((e, j) => j !== i && !isFeedbackEvent(e) && parseTs(e.clampedFrom ?? e.ts) <= ts)
        .slice(-LAST_EVENTS)
        .map((e) => ({ ts: parseTs(e.clampedFrom ?? e.ts), name: e.name, body: '', event: e }));
    out.push({
      key: `fb-${i}`,
      ts,
      message,
      ...(ev.attrs.ouo_feedback_contact ? { contact: ev.attrs.ouo_feedback_contact } : {}),
      screenshot: ev.attrs.ouo_feedback_screenshot === 'true',
      steps,
    });
  });
  return out.sort((a, b) => a.ts - b.ts);
}
