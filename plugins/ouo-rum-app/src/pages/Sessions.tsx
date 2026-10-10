import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2, type SelectableValue } from '@grafana/data';
import { locationService, PluginPage } from '@grafana/runtime';
import { Button, EmptyState, Field, Input, LoadingPlaceholder, Select, Stack, useStyles2 } from '@grafana/ui';
import { rumApi } from '../api/client';
import type { SessionRecord } from '../api/types';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { SessionsTable } from '../components/SessionsTable';
import { TimeRangeBar, useRawRange } from '../components/TimeRangeBar';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useRumQuery } from '../hooks/useRumQuery';
import { setSearchParams, useSearchParams } from '../hooks/useSearchParams';

const PLATFORM_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Any platform', value: '' },
  { label: 'web', value: 'web' },
  { label: 'mobile', value: 'mobile' },
];
const STATUS_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Any status', value: '' },
  { label: 'healthy', value: 'healthy' },
  { label: 'errored', value: 'errored' },
  { label: 'crashed', value: 'crashed' },
];
const LIMIT_OPTIONS: Array<SelectableValue<number>> = [50, 100, 250, 500, 1000].map((n) => ({
  label: String(n),
  value: n,
}));

export function sessionHref(id: string, range: { from: string; to: string }): string {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return `${PLUGIN_BASE_URL}/${ROUTES.Sessions}/${encodeURIComponent(id)}?${q.toString()}`;
}

export default function Sessions() {
  const styles = useStyles2(getStyles);
  const search = useSearchParams();
  const range = useRawRange();
  const filters = useMemo(
    () => ({
      platform: search.get('platform') ?? '',
      status: search.get('status') ?? '',
      version: search.get('version') ?? '',
      user: search.get('user') ?? '',
      service: search.get('service') ?? '',
      limit: Number(search.get('limit') ?? 100) || 100,
    }),
    [search]
  );
  const key = JSON.stringify({ ...filters, ...range });
  const { data, error, loading, reload } = useRumQuery(
    () => rumApi.sessions({ from: range.from, to: range.to, ...filters }),
    key
  );

  // Free-text inputs are committed to the URL on blur / Enter; when the URL changes
  // (back button, Overview link) the inputs are re-synced during render.
  const urlText = `${filters.version}|${filters.user}|${filters.service}`;
  const [text, setText] = useState({ version: filters.version, user: filters.user, service: filters.service });
  const [syncedFrom, setSyncedFrom] = useState(urlText);
  if (syncedFrom !== urlText) {
    setSyncedFrom(urlText);
    setText({ version: filters.version, user: filters.user, service: filters.service });
  }

  const commitText = () => setSearchParams({ version: text.version, user: text.user, service: text.service });
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitText();
    }
  };
  const open = (s: SessionRecord) => locationService.push(sessionHref(s.session_id, range));

  return (
    <PluginPage
      actions={<TimeRangeBar />}
      subTitle="Sessions whose start falls inside the time range, newest first. Click a column header to sort the loaded page (up to the Limit filter) client-side; click a row for the timeline, traces and replay."
    >
      <div className={styles.filters}>
        <Stack gap={1} wrap="wrap" alignItems="flex-end">
          <Field label="Platform" className={styles.field}>
            <Select
              width={18}
              options={PLATFORM_OPTIONS}
              value={filters.platform}
              onChange={(v) => setSearchParams({ platform: v.value })}
            />
          </Field>
          <Field label="Status" className={styles.field}>
            <Select
              width={18}
              options={STATUS_OPTIONS}
              value={filters.status}
              onChange={(v) => setSearchParams({ status: v.value })}
            />
          </Field>
          <Field label="Service" className={styles.field}>
            <Input
              width={20}
              placeholder="any service"
              value={text.service}
              onChange={(e) => setText({ ...text, service: e.currentTarget.value })}
              onBlur={commitText}
              onKeyDown={onKey}
            />
          </Field>
          <Field label="Version" className={styles.field}>
            <Input
              width={16}
              placeholder="any version"
              value={text.version}
              onChange={(e) => setText({ ...text, version: e.currentTarget.value })}
              onBlur={commitText}
              onKeyDown={onKey}
            />
          </Field>
          <Field label="User" className={styles.field}>
            <Input
              width={22}
              placeholder="any user"
              value={text.user}
              onChange={(e) => setText({ ...text, user: e.currentTarget.value })}
              onBlur={commitText}
              onKeyDown={onKey}
            />
          </Field>
          <Field label="Limit" className={styles.field}>
            <Select
              width={12}
              options={LIMIT_OPTIONS}
              value={filters.limit}
              onChange={(v) => setSearchParams({ limit: v.value })}
            />
          </Field>
          <Field label="&nbsp;" className={styles.field}>
            <Stack gap={1}>
              <Button variant="secondary" icon="sync" onClick={reload}>
                Refresh
              </Button>
              <Button
                variant="secondary"
                fill="text"
                onClick={() =>
                  setSearchParams({ platform: null, status: null, version: null, user: null, service: null })
                }
              >
                Clear filters
              </Button>
            </Stack>
          </Field>
        </Stack>
      </div>

      {error && <ApiErrorAlert error={error} onRetry={reload} />}
      {loading && !data && <LoadingPlaceholder text="Loading sessions…" />}
      {data && data.sessions.length === 0 && !error && (
        <EmptyState variant="not-found" message="No sessions match">
          Try a wider time range or fewer filters.
        </EmptyState>
      )}
      {data && data.sessions.length > 0 && (
        <>
          <div className={styles.count}>
            {data.count} session{data.count === 1 ? '' : 's'}
            {data.count >= filters.limit ? ` (limit ${filters.limit} reached)` : ''}
          </div>
          <SessionsTable sessions={data.sessions} onOpen={open} />
        </>
      )}
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  filters: css({ marginBottom: theme.spacing(2) }),
  field: css({ marginBottom: 0 }),
  count: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(1),
  }),
});
