import { useEffect, useState } from 'react';
import { locationService } from '@grafana/runtime';
import { useEmbed } from '../embed/EmbedContext';

/**
 * Current URL query, re-rendered on every Grafana location change. Embedded in a host plugin
 * (ADR-0019) it is the query built from the exposed component's props: the host's URL is not
 * ouo's to read.
 */
export function useSearchParams(): URLSearchParams {
  const embed = useEmbed();
  const [params, setParams] = useState(() => locationService.getSearch());
  useEffect(() => {
    if (embed) {
      return;
    }
    const sub = locationService.getLocationObservable().subscribe((loc) => {
      setParams(new URLSearchParams(loc.search));
    });
    return () => sub.unsubscribe();
  }, [embed]);
  return embed ? embed.search : params;
}

/** Updates query params in place (empty values remove the key). */
export function setSearchParams(update: Record<string, string | number | undefined | null>, replace = true): void {
  const query: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(update)) {
    query[k] = v === undefined || v === null || v === '' ? null : String(v);
  }
  locationService.partial(query, replace);
}
