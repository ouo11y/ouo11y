import type { ReplayKind, SessionRecord, SessionStatus } from '../api/types';

/** Formats a percentage the way rum-api reports it: at most two decimals, no trailing zeros. */
export function formatPct(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '–';
  }
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, '')}%`;
}

/** Percentage of part over total, rounded to two decimals like rum-api (0 when total is 0). */
export function pct(part: number, total: number): number {
  if (!total) {
    return 0;
  }
  return Math.round((part / total) * 10000) / 100;
}

/** Human duration: 850ms, 12.3s, 4m 05s, 1h 02m. */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms) || ms < 0) {
    return '–';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  // Round to whole seconds first so 4m 59.6s reads "5m 00s", never "4m 60s".
  const total = Math.round(s);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes - hours * 60).padStart(2, '0')}m`;
}

/** Offset from a start time, as shown next to timeline events: +0.0s, +12.3s, +4m 05s. */
export function formatRelative(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const abs = Math.abs(offsetMs);
  if (abs < 60_000) {
    return `${sign}${(abs / 1000).toFixed(1)}s`;
  }
  return `${sign}${formatDuration(abs)}`;
}

export function parseTs(ts: string | number | undefined | null): number {
  if (ts === undefined || ts === null) {
    return NaN;
  }
  if (typeof ts === 'number') {
    return ts;
  }
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Number(ts) : ms;
}

/** Session duration in ms: ended_at - started_at, or last_signal_at - started_at while active. */
export function sessionDurationMs(s: { started_at: string; ended_at: string | null; last_signal_at: string }): number {
  const start = parseTs(s.started_at);
  const end = parseTs(s.ended_at ?? s.last_signal_at);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return NaN;
  }
  return Math.max(0, end - start);
}

export function formatDateTime(ts: string | number | undefined | null): string {
  const ms = parseTs(ts);
  if (Number.isNaN(ms)) {
    return '–';
  }
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface ReplaySummary {
  /** `rrweb`, `frames` or `video`; null when the record predates `replay_kind`. */
  kind: ReplayKind | null;
  /** Formatted like the Duration column; null until rum-api reports `replay_duration_ms`. */
  duration: string | null;
}

export function isReplayKind(value: unknown): value is ReplayKind {
  return value === 'rrweb' || value === 'frames' || value === 'video';
}

/** Replay column content: null when the session has no replay. */
export function replaySummary(
  s: Pick<SessionRecord, 'has_replay' | 'replay_kind' | 'replay_duration_ms'>
): ReplaySummary | null {
  if (!s.has_replay) {
    return null;
  }
  const ms = s.replay_duration_ms;
  const duration = ms === undefined || ms === null || Number.isNaN(ms) || ms < 0 ? null : formatDuration(ms);
  const kind = isReplayKind(s.replay_kind) ? s.replay_kind : null;
  return { kind, duration };
}

export function formatTraceCount(n: number): string {
  return n < 0 ? 'n/a' : String(n);
}

export function shortId(id: string, keep = 8): string {
  return id.length <= keep ? id : `${id.slice(0, keep)}…`;
}

export const STATUS_ORDER: SessionStatus[] = ['healthy', 'errored', 'crashed'];

export function isSessionStatus(value: string): value is SessionStatus {
  return (STATUS_ORDER as string[]).includes(value);
}
