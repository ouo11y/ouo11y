import React, { Suspense, useMemo, type ReactNode } from 'react';
import { usePluginContext } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import { DEFAULT_RANGE } from '../constants';
import { EmbedContext, type EmbedState } from '../embed/EmbedContext';
import { FeatureTogglesContext, parseFeatureToggles } from '../featureToggles';
import type { EmbedScopeProps, EmbedTimeRange } from './types';

/** One end of a host's time range as rum-api reads it: relative or ISO; epoch ms become ISO. */
export function rangeValue(value: EmbedTimeRange['from'] | undefined, fallback: string): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const v = value.trim();
    // Epoch milliseconds as a string (what Grafana writes in its own URLs).
    return /^\d{10,}$/.test(v) ? new Date(Number(v)).toISOString() : v;
  }
  return fallback;
}

/**
 * The query an embedded page reads in place of the URL (see `useSearchParams`): the same keys
 * ouo's own pages keep in the URL, so the pages need no embed-specific code.
 */
export function embedSearch(
  props: EmbedScopeProps,
  extra: Record<string, string | number | undefined> = {}
): URLSearchParams {
  const q = new URLSearchParams();
  q.set('from', rangeValue(props.timeRange?.from, DEFAULT_RANGE.from));
  q.set('to', rangeValue(props.timeRange?.to, DEFAULT_RANGE.to));
  // ouo's pages keep the app under `service` (service.name).
  for (const [k, v] of Object.entries({ project: props.project, service: props.app, ...extra })) {
    if (v !== undefined && v !== '') {
      q.set(k, String(v));
    }
  }
  return q;
}

interface Props {
  search: URLSearchParams;
  children: ReactNode;
}

/**
 * Wraps an exposed component: the embed query, the plugin's feature toggles (Grafana renders an
 * exposed component inside the providing plugin's context, so `jsonData` is ouo's settings, not the
 * host's) and a Suspense boundary for the lazily loaded page.
 */
export function EmbedRoot({ search, children }: Props) {
  const context = usePluginContext();
  const rawToggles = (context?.meta?.jsonData as { featureToggles?: unknown } | undefined)?.featureToggles;
  const toggles = useMemo(() => parseFeatureToggles(rawToggles), [rawToggles]);
  const key = search.toString();
  // A new object only when the query changes, so the pages do not refetch on every host render.
  const state = useMemo<EmbedState>(() => ({ search: new URLSearchParams(key) }), [key]);
  return (
    <EmbedContext.Provider value={state}>
      <FeatureTogglesContext.Provider value={toggles}>
        <div className="ouo11y-embed" data-testid="ouo-embed">
          <Suspense fallback={<LoadingPlaceholder text="Loading ouo…" />}>{children}</Suspense>
        </div>
      </FeatureTogglesContext.Provider>
    </EmbedContext.Provider>
  );
}
