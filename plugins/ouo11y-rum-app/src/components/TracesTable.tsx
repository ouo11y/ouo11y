import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Badge, ClipboardButton, LinkButton, useStyles2 } from '@grafana/ui';
import type { TraceSummary } from '../api/types';
import { formatDateTime, formatDuration, shortId } from '../utils/format';

export function TracesTable({ traces }: { traces: TraceSummary[] }) {
  const styles = useStyles2(getStyles);
  if (!traces.length) {
    return (
      <div className={styles.empty}>
        No traces found for this session yet (Tempo indexes traces with a short delay).
      </div>
    );
  }
  return (
    <div className={styles.wrap}>
      <table className={styles.table} data-testid="traces-table">
        <thead>
          <tr>
            <th>Root span</th>
            <th>Service</th>
            <th>Start</th>
            <th className={styles.num}>Duration</th>
            <th className={styles.num}>Spans</th>
            <th>Status</th>
            <th>Trace id</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.trace_id}>
              <td className={styles.name}>{t.root_name}</td>
              <td>{t.root_service}</td>
              <td>{formatDateTime(t.start)}</td>
              <td className={styles.num}>{formatDuration(t.duration_ms)}</td>
              <td className={styles.num}>{t.span_count}</td>
              <td>
                {t.has_error ? (
                  <Badge text="error" color="red" icon="exclamation-triangle" />
                ) : (
                  <Badge text="ok" color="green" />
                )}
              </td>
              <td>
                <span className={styles.id}>
                  <code>{shortId(t.trace_id, 12)}</code>
                  <ClipboardButton
                    size="sm"
                    variant="secondary"
                    fill="text"
                    icon="copy"
                    getText={() => t.trace_id}
                    aria-label="Copy trace id"
                  />
                </span>
              </td>
              <td>
                <LinkButton
                  size="sm"
                  variant="secondary"
                  icon="external-link-alt"
                  href={t.grafana_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in Explore
                </LinkButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({ maxHeight: 560, overflow: 'auto' }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.5, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      whiteSpace: 'nowrap',
    },
    th: {
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
      fontSize: theme.typography.bodySmall.fontSize,
      position: 'sticky',
      top: 0,
      background: theme.colors.background.primary,
    },
  }),
  name: css({ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }),
  num: css({ textAlign: 'right !important' as 'right', fontVariantNumeric: 'tabular-nums' }),
  id: css({ display: 'inline-flex', alignItems: 'center', gap: 2 }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
});
