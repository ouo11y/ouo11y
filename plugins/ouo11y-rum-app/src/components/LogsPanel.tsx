import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { IconButton, Input, LinkButton, RadioButtonGroup, useStyles2, useTheme2 } from '@grafana/ui';
import type { LogLine, LogsResponse } from '../api/types';
import { formatDateTime, formatRelative, parseTs } from '../utils/format';
import { isExceptionLine, logLineText } from '../utils/session';
import { StackTrace } from './StackTrace';

type Scope = 'all' | 'session' | 'trace';

interface Props {
  data: LogsResponse;
  /** Session start in ms; times are shown relative to it. */
  sessionStart: number;
  /** Seeks the replay to a line's time (absolute ms); absent without a replay. */
  onSeek?: (tsMs: number) => void;
}

/** Filters lines by source and by a case-insensitive text match on body, service and level. */
export function filterLogs(logs: LogLine[], scope: Scope, text: string): LogLine[] {
  const needle = text.trim().toLowerCase();
  return logs.filter(
    (l) =>
      (scope === 'all' || l.source === scope) &&
      (!needle || `${logLineText(l)} ${l.service} ${l.level}`.toLowerCase().includes(needle))
  );
}

// Record metadata, not the app's or backend's own attributes (the ouo SDKs put session_previous_id
// on every record, the Sentry bridge network_connection_type).
const HIDDEN_PREFIXES = ['ouo_', 'exception_', 'device_', 'telemetry_', 'os_', 'session_', 'network_'];
const HIDDEN_KEYS = new Set([
  'flags',
  'observed_timestamp',
  'scope_name',
  'deployment_environment_name',
  'service_version',
  'user_id',
]);

/** Attributes worth reading next to the message (the app's or backend's own), as sorted `k=v`. */
export function visibleAttrs(attrs: Record<string, string>): string[] {
  return Object.keys(attrs)
    .filter((k) => !HIDDEN_KEYS.has(k) && !HIDDEN_PREFIXES.some((p) => k.startsWith(p)))
    .sort()
    .map((k) => `${k}=${attrs[k]}`);
}

export function levelColor(theme: GrafanaTheme2, level: string): string {
  switch (level) {
    case 'fatal':
    case 'error':
      return theme.colors.error.text;
    case 'warn':
    case 'warning':
      return theme.colors.warning.text;
    case 'debug':
    case 'trace':
      return theme.colors.text.disabled;
    default:
      return theme.colors.info.text;
  }
}

export function LogsPanel({ data, sessionStart, onSeek }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [scope, setScope] = useState<Scope>('all');
  const [text, setText] = useState('');
  const shown = useMemo(() => filterLogs(data.logs, scope, text), [data.logs, scope, text]);
  const fromTraces = data.logs.filter((l) => l.source === 'trace').length;

  return (
    <div>
      <div className={styles.toolbar}>
        <RadioButtonGroup<Scope>
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { label: `All (${data.logs.length})`, value: 'all' },
            { label: `This session (${data.logs.length - fromTraces})`, value: 'session' },
            {
              label: `Same traces (${fromTraces})`,
              value: 'trace',
              description: 'Other services, e.g. the backend, joined by trace id',
            },
          ]}
        />
        <Input
          className={styles.search}
          prefix={<span aria-hidden>⌕</span>}
          placeholder="Filter text"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          aria-label="Filter logs"
        />
        {data.explore_url && (
          <LinkButton
            size="sm"
            variant="secondary"
            icon="external-link-alt"
            href={data.explore_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Explore
          </LinkButton>
        )}
      </div>
      {data.trace_count < 0 && (
        <div className={styles.note}>Tempo could not be searched: only the session&apos;s own lines are shown.</div>
      )}
      {data.truncated && (
        <div className={styles.note}>Showing the first {data.count} lines; open Explore for all of them.</div>
      )}
      {shown.length === 0 ? (
        <div className={styles.empty}>
          {data.logs.length ? 'No line matches the filter.' : 'No logs for this session.'}
        </div>
      ) : (
        <ol className={styles.list} data-testid="logs">
          {shown.map((l, i) => {
            const ts = parseTs(l.ts);
            return (
              <li
                key={`${l.ts}-${i}`}
                className={cx(styles.row, onSeek && styles.clickable)}
                onClick={onSeek ? () => onSeek(ts) : undefined}
                title={formatDateTime(ts)}
              >
                <span className={styles.time}>{Number.isNaN(ts) ? '' : formatRelative(ts - sessionStart)}</span>
                <span className={styles.level} style={{ color: levelColor(theme, l.level) }}>
                  {(l.level || 'info').toUpperCase()}
                </span>
                <span className={cx(styles.service, l.source === 'trace' && styles.otherService)}>{l.service}</span>
                <span className={styles.body} data-testid="log-body">
                  {logLineText(l)}
                  {visibleAttrs(l.attrs).map((a) => (
                    <span key={a} className={styles.attr}>
                      {a}
                    </span>
                  ))}
                  {isExceptionLine(l) && <StackTrace stack={l.attrs.exception_stacktrace} symbolicated={l.symbolicated} />}
                </span>
                <span className={styles.actions}>
                  {l.trace_url && (
                    <IconButton
                      name="gf-traces"
                      size="sm"
                      tooltip="Open this line's trace in Explore"
                      aria-label="Open trace"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(l.trace_url, '_blank', 'noopener,noreferrer');
                      }}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  toolbar: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(1),
  }),
  search: css({ width: 240 }),
  note: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(1),
  }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    maxHeight: 560,
    overflowY: 'auto',
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  row: css({
    display: 'grid',
    gridTemplateColumns: '72px 48px minmax(80px, 140px) 1fr 28px',
    gap: theme.spacing(1),
    alignItems: 'start',
    padding: theme.spacing(0.25, 1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
  }),
  clickable: css({ cursor: 'pointer', '&:hover': { background: theme.colors.action.hover } }),
  time: css({ color: theme.colors.text.secondary }),
  level: css({ fontWeight: theme.typography.fontWeightMedium }),
  service: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  otherService: css({ color: theme.colors.text.link }),
  body: css({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }),
  attr: css({ color: theme.colors.text.secondary, marginLeft: theme.spacing(1) }),
  actions: css({ display: 'flex', justifyContent: 'flex-end' }),
});
