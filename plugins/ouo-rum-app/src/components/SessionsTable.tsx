import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2, type IconName } from '@grafana/data';
import { Icon, Tooltip, useStyles2 } from '@grafana/ui';
import type { ReplayKind, SessionRecord } from '../api/types';
import {
  formatDateTime,
  formatDuration,
  formatTraceCount,
  replaySummary,
  sessionDurationMs,
  shortId,
} from '../utils/format';
import { DEFAULT_SORT, type SortKey, type SortState, sortSessions, toggleSort } from '../utils/sort';
import { PlatformIcon } from './PlatformIcon';
import { StatusBadge } from './StatusBadge';

interface Props {
  sessions: SessionRecord[];
  onOpen: (session: SessionRecord) => void;
  /** Initial sort; the table keeps its own state after that. */
  initialSort?: SortState;
}

interface Column {
  key: SortKey;
  label: string;
  /** Right-aligned numeric column. */
  num?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'started', label: 'Started' },
  { key: 'status', label: 'Status' },
  { key: 'platform', label: 'Platform' },
  { key: 'service', label: 'Service / version' },
  { key: 'user', label: 'User' },
  { key: 'session', label: 'Session' },
  { key: 'duration', label: 'Duration', num: true },
  { key: 'errors', label: 'Errors', num: true },
  { key: 'crashes', label: 'Crashes', num: true },
  { key: 'failed', label: 'Failed req.', num: true },
  { key: 'traces', label: 'Traces', num: true },
  { key: 'replay', label: 'Replay' },
];

const SORT_HINT = 'Sorts the loaded page client-side (rows limited by the Limit filter)';

const REPLAY_KIND: Record<ReplayKind, { icon: IconName; label: string; title: string }> = {
  rrweb: { icon: 'brackets-curly', label: 'rrweb', title: 'DOM replay recorded by the browser SDK (rrweb)' },
  frames: { icon: 'camera', label: 'frames', title: 'Screenshot replay recorded by the native SDK' },
  video: {
    icon: 'presentation-play',
    label: 'video',
    title: 'Video replay (mp4 segments) recorded by a mobile SDK, e.g. Sentry Session Replay',
  },
};

export function SessionsTable({ sessions, onOpen, initialSort = DEFAULT_SORT }: Props) {
  const styles = useStyles2(getStyles);
  const [sort, setSort] = useState<SortState>(initialSort);
  const sorted = useMemo(() => sortSessions(sessions, sort), [sessions, sort]);

  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="sessions-table" data-sort-key={sort.key} data-sort-dir={sort.dir}>
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  className={cx(c.num && styles.num)}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    type="button"
                    className={cx(styles.sortButton, active && styles.sortActive)}
                    onClick={() => setSort((s) => toggleSort(s, c.key))}
                    title={`${active ? `Sorted ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : 'Sort'} by ${c.label}. ${SORT_HINT}.`}
                    data-testid={`sort-${c.key}`}
                  >
                    {c.label}
                    <span className={styles.sortIcon} aria-hidden="true">
                      {active ? <Icon name={sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" /> : null}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
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
                <ReplayCell session={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Replay column: duration plus the renderer kind, the play icon while the duration is unknown, or a dash. */
export function ReplayCell({ session }: { session: SessionRecord }) {
  const styles = useStyles2(getStyles);
  const replay = replaySummary(session);
  if (!replay) {
    return (
      <span className={styles.muted} data-testid="replay-none">
        –
      </span>
    );
  }
  const kind = replay.kind ? REPLAY_KIND[replay.kind] : null;
  const title = `Replay available${kind ? `: ${kind.title}` : ''}${
    replay.duration ? ` (${replay.duration})` : ' (length not reported by rum-api)'
  }`;
  return (
    <Tooltip content={title}>
      <span className={styles.replay} data-testid="replay-cell" data-replay-kind={replay.kind ?? undefined}>
        {replay.duration ? <span className={styles.replayDuration}>{replay.duration}</span> : <Icon name="play" />}
        {kind && (
          <span className={styles.kind}>
            <Icon name={kind.icon} size="sm" /> {kind.label}
          </span>
        )}
      </span>
    </Tooltip>
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
      padding: 0,
    },
  }),
  sortButton: css({
    all: 'unset',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    width: '100%',
    padding: theme.spacing(0.75, 1),
    cursor: 'pointer',
    color: 'inherit',
    font: 'inherit',
    '&:hover': { color: theme.colors.text.primary, background: theme.colors.action.hover },
    '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: -2 },
  }),
  sortActive: css({ color: theme.colors.text.primary }),
  sortIcon: css({ display: 'inline-flex', width: 14, justifyContent: 'center' }),
  row: css({
    cursor: 'pointer',
    '&:hover': { background: theme.colors.action.hover },
    '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: -2 },
  }),
  num: css({
    textAlign: 'right !important' as 'right',
    fontVariantNumeric: 'tabular-nums',
    '& > button': { justifyContent: 'flex-end' },
  }),
  muted: css({ color: theme.colors.text.secondary }),
  active: css({ color: theme.colors.info.text }),
  warn: css({ color: theme.colors.warning.text }),
  err: css({ color: theme.colors.error.text, fontWeight: theme.typography.fontWeightMedium }),
  replay: css({ display: 'inline-flex', alignItems: 'center', gap: theme.spacing(1) }),
  replayDuration: css({ fontVariantNumeric: 'tabular-nums' }),
  kind: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(0, 0.5),
    lineHeight: 1.6,
  }),
});
