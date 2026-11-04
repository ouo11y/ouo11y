import React, { useCallback } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import { EmptyState, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { rumApi } from '../api/client';
import type { SessionRecord } from '../api/types';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { SessionsTable } from '../components/SessionsTable';
import { useRawRange } from '../components/TimeRangeBar';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useRumQuery } from '../hooks/useRumQuery';
import { useSearchParams } from '../hooks/useSearchParams';
import type { SessionsListFilters } from './types';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** The `limit` prop clamped to what rum-api serves; anything that is not a positive number is the default. */
export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** ouo's own Session page for a session, with the range and scope (the link-out default). */
export function ouoSessionUrl(id: string, search: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const key of ['from', 'to', 'project', 'service']) {
    const v = search.get(key);
    if (v) {
      q.set(key, v);
    }
  }
  return `${PLUGIN_BASE_URL}/${ROUTES.Sessions}/${encodeURIComponent(id)}?${q.toString()}`;
}

interface Props {
  filters?: SessionsListFilters;
  limit?: number;
  onSessionClick?: (sessionId: string) => void;
}

/**
 * The sessions table of `ouo11y-rum-app/sessions-list/v1`. Filters come from props (the host owns
 * the filter UI); time range and scope from the embed query (`EmbedRoot`).
 */
export default function SessionsList({ filters, limit, onSessionClick }: Props) {
  const styles = useStyles2(getStyles);
  const search = useSearchParams();
  const range = useRawRange();
  const max = clampLimit(limit);
  const params = {
    from: range.from,
    to: range.to,
    project: search.get('project') ?? undefined,
    service: search.get('service') ?? undefined,
    platform: filters?.platform,
    status: filters?.status,
    version: filters?.version,
    user: filters?.user,
    limit: max,
  };
  const key = JSON.stringify(params);
  const { data, error, loading, reload } = useRumQuery(() => rumApi.sessions(params), key);

  const open = useCallback(
    (s: SessionRecord) => {
      if (onSessionClick) {
        onSessionClick(s.session_id);
      } else {
        locationService.push(ouoSessionUrl(s.session_id, search));
      }
    },
    [onSessionClick, search]
  );

  return (
    <div data-testid="ouo-sessions-list">
      {error && <ApiErrorAlert error={error} onRetry={reload} />}
      {loading && !data && <LoadingPlaceholder text="Loading sessions…" />}
      {data && data.sessions.length === 0 && !error && (
        <EmptyState variant="not-found" message="No sessions match">
          No session started in this time range with these filters.
        </EmptyState>
      )}
      {data && data.sessions.length > 0 && (
        <>
          <div className={styles.count}>
            {data.count} session{data.count === 1 ? '' : 's'}
            {data.count >= max ? ` (limit ${max} reached)` : ''}
          </div>
          <SessionsTable sessions={data.sessions} onOpen={open} />
        </>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  count: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(1),
  }),
});
