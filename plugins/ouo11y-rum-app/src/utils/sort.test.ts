import type { SessionRecord } from '../api/types';
import { compareSessions, DEFAULT_SORT, replaySortValue, sortSessions, sortValue, toggleSort } from './sort';

function session(over: Partial<SessionRecord> & { session_id: string }): SessionRecord {
  return {
    user_id: null,
    platform: 'web',
    service_name: 'web-demo',
    service_version: '1.0.0',
    started_at: '2026-10-08T10:00:00Z',
    last_signal_at: '2026-10-08T10:01:00Z',
    ended_at: '2026-10-08T10:01:00Z',
    end_reason: 'inactivity',
    state: 'ended',
    status: 'healthy',
    error_count: 0,
    crash_count: 0,
    failed_request_count: 0,
    event_count: 1,
    trace_count: 0,
    has_replay: false,
    ...over,
  };
}

const a = session({
  session_id: 'a',
  started_at: '2026-10-08T10:00:00Z',
  ended_at: '2026-10-08T10:05:00Z',
  status: 'crashed',
  crash_count: 1,
  error_count: 2,
  user_id: 'zed',
  platform: 'mobile',
  service_name: 'mobile-demo',
  trace_count: -1,
  has_replay: true,
  replay_kind: 'frames',
  replay_duration_ms: 30_000,
});
const b = session({
  session_id: 'b',
  started_at: '2026-10-08T12:00:00Z',
  ended_at: '2026-10-08T12:00:30Z',
  status: 'healthy',
  user_id: 'Amy',
  trace_count: 4,
  has_replay: true,
  replay_kind: 'rrweb',
});
const c = session({
  session_id: 'c',
  started_at: '2026-10-08T11:00:00Z',
  ended_at: null,
  last_signal_at: '2026-10-08T11:02:00Z',
  state: 'active',
  status: 'errored',
  error_count: 1,
  failed_request_count: 3,
  trace_count: 2,
  service_version: '0.9.0',
});

const ids = (rows: SessionRecord[]) => rows.map((s) => s.session_id);

describe('sortSessions', () => {
  it('defaults to started desc and does not mutate the input', () => {
    const input = [a, b, c];
    expect(ids(sortSessions(input, DEFAULT_SORT))).toEqual(['b', 'c', 'a']);
    expect(ids(input)).toEqual(['a', 'b', 'c']);
    expect(ids(sortSessions(input, { key: 'started', dir: 'asc' }))).toEqual(['a', 'c', 'b']);
  });

  it('orders status by severity, not alphabetically', () => {
    expect(ids(sortSessions([a, b, c], { key: 'status', dir: 'asc' }))).toEqual(['b', 'c', 'a']);
    expect(ids(sortSessions([a, b, c], { key: 'status', dir: 'desc' }))).toEqual(['a', 'c', 'b']);
  });

  it('sorts numeric columns numerically and text columns case-insensitively', () => {
    expect(ids(sortSessions([a, b, c], { key: 'duration', dir: 'desc' }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortSessions([a, b, c], { key: 'errors', dir: 'desc' }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortSessions([a, b, c], { key: 'failed', dir: 'desc' }))).toEqual(['c', 'b', 'a']);
    expect(ids(sortSessions([a, b, c], { key: 'traces', dir: 'asc' }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortSessions([a, b, c], { key: 'user', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
    expect(ids(sortSessions([a, b, c], { key: 'service', dir: 'asc' }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortSessions([a, b, c], { key: 'platform', dir: 'desc' }))).toEqual(['b', 'c', 'a']);
  });

  it('orders replay as none < unknown length < length', () => {
    expect(replaySortValue({ has_replay: false })).toBe(-1);
    expect(replaySortValue({ has_replay: true })).toBe(0);
    expect(replaySortValue({ has_replay: true, replay_duration_ms: null })).toBe(0);
    expect(replaySortValue({ has_replay: true, replay_duration_ms: 1500 })).toBe(1500);
    expect(ids(sortSessions([a, b, c], { key: 'replay', dir: 'desc' }))).toEqual(['a', 'b', 'c']);
    expect(ids(sortSessions([a, b, c], { key: 'replay', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
  });

  it('breaks ties by newest start then session id so the order is stable', () => {
    const x = session({ session_id: 'x', started_at: '2026-10-08T09:00:00Z' });
    const y = session({ session_id: 'y', started_at: '2026-10-08T09:30:00Z' });
    const z = session({ session_id: 'z', started_at: '2026-10-08T09:30:00Z' });
    expect(ids(sortSessions([x, z, y], { key: 'errors', dir: 'asc' }))).toEqual(['y', 'z', 'x']);
    expect(ids(sortSessions([x, z, y], { key: 'errors', dir: 'desc' }))).toEqual(['y', 'z', 'x']);
    expect(compareSessions(y, z, { key: 'started', dir: 'desc' })).toBeLessThan(0);
  });

  it('maps unparsable timestamps and unknown statuses to the end of the natural order', () => {
    expect(sortValue(session({ session_id: 'n', started_at: 'garbage' }), 'started')).toBe(-1);
    expect(sortValue(session({ session_id: 'n', status: 'weird' }), 'status')).toBe(3);
    expect(sortValue(session({ session_id: 'n', started_at: 'garbage', ended_at: null }), 'duration')).toBe(-1);
  });
});

describe('toggleSort', () => {
  it('flips the active column and starts other columns with their default direction', () => {
    expect(toggleSort(DEFAULT_SORT, 'started')).toEqual({ key: 'started', dir: 'asc' });
    expect(toggleSort({ key: 'started', dir: 'asc' }, 'started')).toEqual({ key: 'started', dir: 'desc' });
    expect(toggleSort(DEFAULT_SORT, 'user')).toEqual({ key: 'user', dir: 'asc' });
    expect(toggleSort(DEFAULT_SORT, 'errors')).toEqual({ key: 'errors', dir: 'desc' });
    expect(toggleSort(DEFAULT_SORT, 'status')).toEqual({ key: 'status', dir: 'asc' });
    expect(toggleSort(DEFAULT_SORT, 'replay')).toEqual({ key: 'replay', dir: 'desc' });
  });
});
