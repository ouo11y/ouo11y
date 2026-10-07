import React, { useMemo } from 'react';
import { TimeRangePicker } from '@grafana/ui';
import { setSearchParams, useSearchParams } from '../hooks/useSearchParams';
import {
  rawRangeFromSearch,
  shiftRange,
  toRawRange,
  toTimeRange,
  zoomOutRange,
  type RawRange,
} from '../utils/timerange';

/** Grafana time range picker whose state lives in the URL (`from`, `to`). */
export function useRawRange(): RawRange {
  const search = useSearchParams();
  return useMemo(() => rawRangeFromSearch(search), [search]);
}

export function TimeRangeBar() {
  const raw = useRawRange();
  const range = useMemo(() => toTimeRange(raw), [raw]);
  const apply = (next: RawRange) => setSearchParams({ from: next.from, to: next.to });
  return (
    <TimeRangePicker
      value={range}
      onChange={(r) => apply(toRawRange(r))}
      onChangeTimeZone={() => undefined}
      onMoveBackward={() => apply(shiftRange(range, -1))}
      onMoveForward={() => apply(shiftRange(range, 1))}
      onZoom={() => apply(zoomOutRange(range))}
    />
  );
}
