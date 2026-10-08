import { dateTime, rangeUtil, type RawTimeRange, type TimeRange } from '@grafana/data';
import { DEFAULT_RANGE } from '../constants';

/** Raw from/to strings as rum-api understands them (relative `now-1h` or absolute ISO). */
export interface RawRange {
  from: string;
  to: string;
}

export function rawRangeFromSearch(search: URLSearchParams): RawRange {
  return {
    from: search.get('from') || DEFAULT_RANGE.from,
    to: search.get('to') || DEFAULT_RANGE.to,
  };
}

export function toTimeRange(raw: RawRange): TimeRange {
  const rawRange: RawTimeRange = {
    from: isRelative(raw.from) ? raw.from : dateTime(raw.from),
    to: isRelative(raw.to) ? raw.to : dateTime(raw.to),
  };
  return rangeUtil.convertRawToRange(rawRange);
}

export function isRelative(value: string): boolean {
  return value.startsWith('now');
}

/** Serializes a Grafana TimeRange back to strings rum-api accepts. */
export function toRawRange(range: TimeRange): RawRange {
  const ser = (v: TimeRange['raw']['from']) => (typeof v === 'string' ? v : v.toISOString());
  return { from: ser(range.raw.from), to: ser(range.raw.to) };
}

export function shiftRange(range: TimeRange, direction: -1 | 1): RawRange {
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  const span = to - from;
  const delta = (direction * span) / 2;
  return { from: new Date(from + delta).toISOString(), to: new Date(to + delta).toISOString() };
}

export function zoomOutRange(range: TimeRange): RawRange {
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  const span = to - from;
  return { from: new Date(from - span / 2).toISOString(), to: new Date(to + span / 2).toISOString() };
}
