import type { ReplayFrame, TimelineEvent } from '../api/types';
import { parseTs } from './format';

/** How many steps before a feedback are listed (docs/specs/mobile-sdk.md C10). */
export const LAST_EVENTS = 20;

/**
 * Where the frame an SDK took for a feedback (reason `feedback`, C10) may lie: the first one up to
 * 2 s after the record (the recorder takes it at its next pass, once a running transition
 * settled), else one up to 0.5 s before it (the record and the frame are stamped with two clocks,
 * which part only when the wall clock jumps).
 */
export const FEEDBACK_FRAME_AFTER_MS = 2000;
export const FEEDBACK_FRAME_BEFORE_MS = 500;

/** The time (epoch ms) of the frame taken for a feedback at `ts`, when the replay holds one. */
export function feedbackFrameTs(frames: readonly ReplayFrame[] | undefined, ts: number): number | undefined {
  const taken = (frames ?? []).filter((f) => f.reason === 'feedback');
  return (
    taken.find((f) => f.ts >= ts && f.ts <= ts + FEEDBACK_FRAME_AFTER_MS)?.ts ??
    taken.filter((f) => f.ts < ts && f.ts >= ts - FEEDBACK_FRAME_BEFORE_MS).at(-1)?.ts
  );
}

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
  /** Epoch ms of the frame the SDK took for it (reason `feedback`), when the replay holds one: the screenshot. */
  frameTs?: number;
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
 * (the Sentry bridge, whose feedback breadcrumbs are timeline events). A record whose
 * `ouo.feedback.id` was already listed (an envelope the Sentry SDK sent again) is listed once.
 */
export function buildFeedback(timeline: readonly TimelineEvent[], frames?: readonly ReplayFrame[]): FeedbackItem[] {
  const out: FeedbackItem[] = [];
  const seen = new Set<string>();
  timeline.forEach((ev, i) => {
    if (!isFeedbackEvent(ev)) {
      return;
    }
    const id = ev.attrs.ouo_feedback_id;
    if (id) {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
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
    const screenshot = ev.attrs.ouo_feedback_screenshot === 'true';
    const frameTs = screenshot ? feedbackFrameTs(frames, ts) : undefined;
    out.push({
      key: `fb-${i}`,
      ts,
      message,
      ...(ev.attrs.ouo_feedback_contact ? { contact: ev.attrs.ouo_feedback_contact } : {}),
      screenshot,
      ...(frameTs !== undefined ? { frameTs } : {}),
      steps,
    });
  });
  return out.sort((a, b) => a.ts - b.ts);
}
