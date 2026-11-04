import React, { useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { EmptyState, Field, Input, LoadingPlaceholder, Stack, useStyles2 } from '@grafana/ui';
import { slowestInteractions } from '../api/vitals';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { SlowestInteractions } from '../components/SlowestInteractions';
import { TimeRangeBar, useRawRange } from '../components/TimeRangeBar';
import { useRumQuery } from '../hooks/useRumQuery';
import { setSearchParams, useSearchParams } from '../hooks/useSearchParams';

/** URL parameters of the page, committed on blur / Enter (Sessions page pattern). */
export const PERFORMANCE_FILTERS = ['service', 'environment', 'release', 'project', 'page'] as const;
type Filter = (typeof PERFORMANCE_FILTERS)[number];

function filtersFrom(search: URLSearchParams): Record<Filter, string> {
  return Object.fromEntries(PERFORMANCE_FILTERS.map((k) => [k, search.get(k) ?? ''])) as Record<Filter, string>;
}

export default function Performance() {
  const styles = useStyles2(getStyles);
  const search = useSearchParams();
  const range = useRawRange();
  const filters = filtersFrom(search);
  const urlText = PERFORMANCE_FILTERS.map((k) => filters[k]).join('|');
  const [text, setText] = useState(filters);
  const [syncedFrom, setSyncedFrom] = useState(urlText);
  if (syncedFrom !== urlText) {
    setSyncedFrom(urlText);
    setText(filters);
  }
  const commit = () => setSearchParams(text);

  const query = useRumQuery(
    () => slowestInteractions({ from: range.from, to: range.to, platform: 'web', ...filters }),
    JSON.stringify({ range, filters })
  );
  const data = query.data;

  return (
    <PluginPage
      actions={<TimeRangeBar />}
      subTitle="Slowest interactions by element: the 75th percentile of INP per element and page, its three phases, and the script that ran longest during them (Long Animation Frames, Chromium)."
    >
      <div className={styles.section}>
        <Stack gap={1} wrap="wrap">
          {PERFORMANCE_FILTERS.map((k) => (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)} className={styles.field}>
              <Input
                aria-label={k}
                width={k === 'page' ? 28 : 20}
                placeholder={k === 'page' ? 'route or path' : undefined}
                value={text[k]}
                onChange={(e) => setText({ ...text, [k]: e.currentTarget.value })}
                onBlur={commit}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
              />
            </Field>
          ))}
        </Stack>
      </div>
      {query.error && <ApiErrorAlert error={query.error} onRetry={query.reload} />}
      {!data && query.loading && <LoadingPlaceholder text="Loading interactions…" />}
      {data && data.groups.length === 0 && (
        <EmptyState variant="not-found" message="No INP in this range">
          The browser SDK reports INP when a page is hidden or left, in browsers with the Event Timing API.
        </EmptyState>
      )}
      {data && data.groups.length > 0 && (
        <>
          <p className={styles.summary}>
            {data.page_views} page views with an interaction, {data.total} elements
            {data.total > data.groups.length ? `, the slowest ${data.groups.length} shown` : ''}.
          </p>
          <SlowestInteractions groups={data.groups} />
        </>
      )}
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  section: css({ marginBottom: theme.spacing(2) }),
  field: css({ marginBottom: 0 }),
  summary: css({ color: theme.colors.text.secondary }),
});
