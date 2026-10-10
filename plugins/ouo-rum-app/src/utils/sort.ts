import type { SessionRecord, SessionStatus } from '../api/types';
import { parseTs, sessionDurationMs, STATUS_ORDER } from './format';

/** One key per column of the sessions table. */
export type SortKey =
  | 'started'
  | 'status'
  | 'platform'
  | 'service'
  | 'user'
  | 'session'
  | 'duration'
  | 'errors'
  | 'crashes'
  | 'failed'
  | 'traces'
  | 'replay';
export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: 'started', dir: 'desc' };

/** Direction a column starts with when it becomes the sort key: newest / biggest first, text A to Z. */
export function defaultDir(key: SortKey): SortDir {
  switch (key) {
    case 'platform':
    case 'service':
    case 'user':
    case 'session':
    case 'status':
      return 'asc';
    default:
      return 'desc';
  }
}

/** Clicking the active column flips its direction; clicking another column selects it with its default direction. */
export function toggleSort(state: SortState, key: SortKey): SortState {
  if (state.key === key) {
    return { key, dir: state.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { key, dir: defaultDir(key) };
}

/** Replay column order: no replay < replay with unknown length < replay length in ms. */
export function replaySortValue(s: Pick<SessionRecord, 'has_replay' | 'replay_duration_ms'>): number {
  if (!s.has_replay) {
    return -1;
  }
  const ms = s.replay_duration_ms;
  if (ms === undefined || ms === null || Number.isNaN(ms) || ms < 0) {
    return 0;
  }
  return ms;
}

/** Comparable value of a column: numbers compare numerically, strings case-insensitively. */
export function sortValue(s: SessionRecord, key: SortKey): number | string {
  switch (key) {
    case 'started': {
      const ms = parseTs(s.started_at);
      return Number.isNaN(ms) ? -1 : ms;
    }
    case 'status': {
      const i = STATUS_ORDER.indexOf(s.status as SessionStatus);
      return i < 0 ? STATUS_ORDER.length : i;
    }
    case 'platform':
      return s.platform;
    case 'service':
      return `${s.service_name} ${s.service_version}`;
    case 'user':
      return s.user_id ?? '';
    case 'session':
      return s.session_id;
    case 'duration': {
      const ms = sessionDurationMs(s);
      return Number.isNaN(ms) ? -1 : ms;
    }
    case 'errors':
      return s.error_count;
    case 'crashes':
      return s.crash_count;
    case 'failed':
      return s.failed_request_count;
    case 'traces':
      return s.trace_count;
    case 'replay':
      return replaySortValue(s);
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

/** Stable comparator: the sort column, then newest first, then session id, so equal rows keep a fixed order. */
export function compareSessions(a: SessionRecord, b: SessionRecord, sort: SortState): number {
  const primary = compareValues(sortValue(a, sort.key), sortValue(b, sort.key));
  if (primary !== 0) {
    return sort.dir === 'asc' ? primary : -primary;
  }
  const byStart = compareValues(sortValue(b, 'started'), sortValue(a, 'started'));
  return byStart !== 0 ? byStart : a.session_id.localeCompare(b.session_id);
}

/** Returns a sorted copy; the input is not mutated. */
export function sortSessions(sessions: SessionRecord[], sort: SortState): SessionRecord[] {
  return [...sessions].sort((a, b) => compareSessions(a, b, sort));
}
