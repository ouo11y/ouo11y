import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, EmptyState, LoadingPlaceholder, RadioButtonGroup, Stack, useStyles2 } from '@grafana/ui';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { bff, useBff } from './bff';
import { ClearanceNote } from './ClearanceNote';
import { duration, time } from './format';

const RANGES = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
];
const RANGE_MS: Record<string, number> = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

export function sessionHref(project: string, id: string, from: number, to: number): string {
  return `${PLUGIN_BASE_URL}/${ROUTES.Explore}/${project}/${id}?from=${from}&to=${to}`;
}

/** Session explorer: the sessions with records in the range, newest first, from the BFF. */
export default function ExploreSessions() {
  const styles = useStyles2(getStyles);
  // The window is fixed when the range is chosen, so links carry the window the list was read in.
  const [{ range, to }, setWindow] = useState(() => ({ range: '24h', to: Date.now() }));
  const from = to - RANGE_MS[range];
  const me = useBff(() => bff.me(), 'me');
  const list = useBff(() => bff.sessions(from, to), `${from}`);

  return (
    <PluginPage>
      <Stack direction="column" gap={2}>
        <Stack justifyContent="space-between" alignItems="center">
          <RadioButtonGroup options={RANGES} value={range} onChange={(v) => setWindow({ range: v, to: Date.now() })} />
          {me.data && <Badge color="blue" text={`Clearance c${me.data.level}`} />}
        </Stack>
        <ClearanceNote me={me.data} redacted={list.data?.redacted} />
        {list.error && (
          <Alert severity="error" title="Sessions could not be read">
            {list.error.message}
          </Alert>
        )}
        {list.loading && !list.data && <LoadingPlaceholder text="Loading sessions…" />}
        {list.data?.truncated && (
          <Alert severity="warning" title="Partial list">
            The range holds more records than one read covers; older sessions may be missing. Narrow the range.
          </Alert>
        )}
        {list.data && list.data.sessions.length === 0 && (
          <EmptyState variant="not-found" message="No sessions in this range" />
        )}
        {list.data && list.data.sessions.length > 0 && (
          <table className={styles.table} data-testid="explore-sessions">
            <thead>
              <tr>
                <th>Last seen</th>
                <th>Project</th>
                <th>Service</th>
                <th>Duration</th>
                <th>Events</th>
                <th>Errors</th>
                <th>Replay</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              {list.data.sessions.map((s) => (
                <tr key={`${s.project}/${s.id}`}>
                  <td>
                    <Link to={sessionHref(s.project, s.id, from, to)} data-testid="session-link">
                      {time(s.end)}
                    </Link>
                  </td>
                  <td>{s.project}</td>
                  <td>{s.service}</td>
                  <td>{duration(s.end - s.start)}</td>
                  <td>{s.event_count}</td>
                  <td>{s.error_count > 0 ? <Badge color="red" text={String(s.error_count)} /> : 0}</td>
                  <td>{s.has_replay ? 'yes' : ''}</td>
                  <td>{s.user ?? (me.data?.can.identity ? '' : <span className={styles.hidden}>hidden</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Stack>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': { padding: theme.spacing(0.75, 1), borderBottom: `1px solid ${theme.colors.border.weak}`, textAlign: 'left' },
    th: { color: theme.colors.text.secondary, fontWeight: theme.typography.fontWeightMedium },
  }),
  hidden: css({ color: theme.colors.text.disabled, fontStyle: 'italic' }),
});
