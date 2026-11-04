import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import { Badge, Button, IconButton, LoadingPlaceholder, RadioButtonGroup, Stack, useStyles2 } from '@grafana/ui';
import { rumApi } from '../api/client';
import type { FunnelFilters, FunnelOutcome } from '../api/types';
import { useRumQuery } from '../hooks/useRumQuery';
import { sessionHref } from '../pages/Sessions';
import { formatDateTime, formatDuration, parseTs, shortId } from '../utils/format';
import type { RawRange } from '../utils/timerange';
import { ApiErrorAlert } from './ApiErrorAlert';

export const DROPPED_PAGE_SIZE = 25;

const OUTCOME_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Failed', value: 'failed', description: 'a failure event followed the last step reached' },
  { label: 'Abandoned', value: 'abandoned', description: 'no failure event' },
];

interface Props {
  /** 1-based step the sessions did not reach. */
  step: number;
  stepsParam: string;
  range: RawRange;
  within: string;
  filters: FunnelFilters;
  /** Compact failure event (`failure` parameter); undefined for rum-api's default. */
  failure?: string;
  /** Failure tracking is off: no outcome filter or column. */
  failureOff?: boolean;
  outcome?: FunnelOutcome;
  onOutcome: (outcome: FunnelOutcome | undefined) => void;
  offset: number;
  onPage: (offset: number) => void;
  onClose: () => void;
}

/**
 * Sessions that reached step N-1 but not step N, latest first, all or only the failed / abandoned ones;
 * a row opens the session and its replay. A failed row shows the failure event and its message.
 */
export function DroppedSessions({
  step,
  stepsParam,
  range,
  within,
  filters,
  failure,
  failureOff,
  outcome,
  onOutcome,
  offset,
  onPage,
  onClose,
}: Props) {
  const styles = useStyles2(getStyles);
  const params = {
    steps: stepsParam,
    step,
    from: range.from,
    to: range.to,
    within: within || undefined,
    failure,
    outcome,
    ...filters,
    limit: DROPPED_PAGE_SIZE,
    offset,
  };
  const { data, error, loading, reload } = useRumQuery(() => rumApi.funnelDropped(params), JSON.stringify(params));
  const open = (id: string) => locationService.push(sessionHref(id, range));

  return (
    <div className={styles.panel} aria-label={`Sessions dropped before step ${step}`}>
      <Stack justifyContent="space-between" alignItems="center">
        <h4 className={styles.title}>
          {outcome === 'failed' ? 'Failed' : outcome === 'abandoned' ? 'Abandoned' : 'Dropped'} before step {step}
          {data ? ` · ${data.total} sessions` : ''}
        </h4>
        <Stack gap={1} alignItems="center">
          {!failureOff && (
            <RadioButtonGroup
              size="sm"
              options={OUTCOME_OPTIONS}
              value={outcome ?? ''}
              onChange={(v) => onOutcome(v === 'failed' || v === 'abandoned' ? v : undefined)}
            />
          )}
          <IconButton name="times" tooltip="Close" onClick={onClose} />
        </Stack>
      </Stack>
      {error && <ApiErrorAlert error={error} onRetry={reload} />}
      {loading && !data && <LoadingPlaceholder text="Loading sessions…" />}
      {data && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Session</th>
                <th>User</th>
                <th>Entered</th>
                <th>Stuck for</th>
                <th>Last page</th>
                {!failureOff && <th>Outcome</th>}
                <th>Replay</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.session_id} className={styles.row} onClick={() => open(s.session_id)}>
                  <td>
                    <a href={sessionHref(s.session_id, range)} onClick={(e) => e.preventDefault()} title={s.session_id}>
                      {shortId(s.session_id)}
                    </a>
                  </td>
                  <td>{s.user_id ? shortId(s.user_id) : '–'}</td>
                  <td>{formatDateTime(s.entered_at)}</td>
                  <td title="Time from step 1 to the last step reached">
                    {formatDuration(parseTs(s.last_step_at) - parseTs(s.entered_at))}
                  </td>
                  <td>{s.last_path ?? '–'}</td>
                  {!failureOff && (
                    <td className={styles.outcome}>
                      {s.outcome === 'failed' ? (
                        <span title={s.failure_message}>
                          <Badge color="red" icon="exclamation-triangle" text={`failed: ${s.failure_event ?? ''}`} />{' '}
                          {s.failed_at && (
                            <span className={styles.muted}>
                              +{formatDuration(parseTs(s.failed_at) - parseTs(s.last_step_at))}
                            </span>
                          )}{' '}
                          {s.failure_message && <span className={styles.message}>{s.failure_message}</span>}
                        </span>
                      ) : (
                        <span className={styles.muted}>abandoned</span>
                      )}
                    </td>
                  )}
                  <td>
                    {s.has_replay ? (
                      <Button size="sm" variant="secondary" icon="play" onClick={() => open(s.session_id)}>
                        Replay
                      </Button>
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Stack gap={1} alignItems="center">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => onPage(Math.max(0, offset - DROPPED_PAGE_SIZE))}
            >
              Previous
            </Button>
            <span className={styles.muted}>
              {data.total === 0 ? 0 : offset + 1}–{offset + data.sessions.length} of {data.total}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={data.next_offset === null}
              onClick={() => data.next_offset !== null && onPage(data.next_offset)}
            >
              Next
            </Button>
          </Stack>
        </>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css({
    marginTop: theme.spacing(2),
    padding: theme.spacing(2),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  title: css({ margin: 0 }),
  table: css({
    width: '100%',
    margin: theme.spacing(1, 0),
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.5, 1),
      textAlign: 'left',
      borderBottom: `1px solid ${theme.colors.border.weak}`,
    },
    th: { color: theme.colors.text.secondary, fontWeight: theme.typography.fontWeightMedium },
  }),
  row: css({ cursor: 'pointer', '&:hover': { background: theme.colors.action.hover } }),
  muted: css({ color: theme.colors.text.secondary }),
  outcome: css({ maxWidth: 420 }),
  message: css({
    display: 'inline-block',
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'bottom',
    color: theme.colors.text.secondary,
  }),
});
