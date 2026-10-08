import React from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, Tooltip, useStyles2 } from '@grafana/ui';
import type { SessionRecord } from '../api/types';
import { formatDateTime, formatDuration, formatTraceCount, sessionDurationMs, shortId } from '../utils/format';
import { PlatformIcon } from './PlatformIcon';
import { StatusBadge } from './StatusBadge';

interface Props {
  sessions: SessionRecord[];
  onOpen: (session: SessionRecord) => void;
}

export function SessionsTable({ sessions, onOpen }: Props) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="sessions-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Platform</th>
            <th>Service / version</th>
            <th>User</th>
            <th>Session</th>
            <th className={styles.num}>Duration</th>
            <th className={styles.num}>Errors</th>
            <th className={styles.num}>Crashes</th>
            <th className={styles.num}>Failed req.</th>
            <th className={styles.num}>Traces</th>
            <th>Replay</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={s.session_id}
              className={styles.row}
              onClick={() => onOpen(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onOpen(s);
                }
              }}
              tabIndex={0}
              role="link"
              data-session-id={s.session_id}
            >
              <td>{formatDateTime(s.started_at)}</td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td>
                <PlatformIcon platform={s.platform} />
              </td>
              <td>
                {s.service_name} <span className={styles.muted}>{s.service_version}</span>
              </td>
              <td>{s.user_id || <span className={styles.muted}>anonymous</span>}</td>
              <td>
                <Tooltip content={s.session_id}>
                  <code>{shortId(s.session_id)}</code>
                </Tooltip>
              </td>
              <td className={styles.num}>
                {s.state === 'active' ? (
                  <span className={styles.active}>active</span>
                ) : (
                  formatDuration(sessionDurationMs(s))
                )}
              </td>
              <td className={cx(styles.num, s.error_count > 0 && styles.warn)}>{s.error_count}</td>
              <td className={cx(styles.num, s.crash_count > 0 && styles.err)}>{s.crash_count}</td>
              <td className={cx(styles.num, s.failed_request_count > 0 && styles.warn)}>{s.failed_request_count}</td>
              <td className={styles.num}>{formatTraceCount(s.trace_count)}</td>
              <td>
                {s.has_replay ? (
                  <Tooltip content="Replay available">
                    <Icon name="play" />
                  </Tooltip>
                ) : (
                  <span className={styles.muted}>–</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  scroll: css({ overflowX: 'auto' }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.75, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      whiteSpace: 'nowrap',
    },
    th: {
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  row: css({
    cursor: 'pointer',
    '&:hover': { background: theme.colors.action.hover },
    '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: -2 },
  }),
  num: css({ textAlign: 'right !important' as 'right', fontVariantNumeric: 'tabular-nums' }),
  muted: css({ color: theme.colors.text.secondary }),
  active: css({ color: theme.colors.info.text }),
  warn: css({ color: theme.colors.warning.text }),
  err: css({ color: theme.colors.error.text, fontWeight: theme.typography.fontWeightMedium }),
});
