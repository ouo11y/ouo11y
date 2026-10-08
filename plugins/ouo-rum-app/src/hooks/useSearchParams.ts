import { useEffect, useState } from 'react';
import { locationService } from '@grafana/runtime';

/** Current URL query, re-rendered on every Grafana location change. */
export function useSearchParams(): URLSearchParams {
  const [params, setParams] = useState(() => locationService.getSearch());
  useEffect(() => {
    const sub = locationService.getLocationObservable().subscribe((loc) => {
      setParams(new URLSearchParams(loc.search));
    });
    return () => sub.unsubscribe();
  }, []);
  return params;
}

/** Updates query params in place (empty values remove the key). */
export function setSearchParams(update: Record<string, string | number | undefined | null>, replace = true): void {
  const query: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(update)) {
    query[k] = v === undefined || v === null || v === '' ? null : String(v);
  }
  locationService.partial(query, replace);
}
