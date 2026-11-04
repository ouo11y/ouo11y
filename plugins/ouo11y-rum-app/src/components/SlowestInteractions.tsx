import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Tooltip, useStyles2 } from '@grafana/ui';
import type { InteractionGroup, InteractionScript } from '../api/vitals';

interface Props {
  groups: InteractionGroup[];
}

/** `480 ms`; an em dash when the phase was not sent. */
export function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? '–' : `${Math.round(ms)} ms`;
}

/** The script column: invoker, else `function (file)`; the file is shortened to its last segment. */
export function scriptLabel(s: InteractionScript | null): string {
  if (!s) {
    return '–';
  }
  const file = s.file ? (s.file.split('?')[0].split('/').filter(Boolean).pop() ?? s.file) : '';
  const where = [s.function, file && `(${file})`].filter(Boolean).join(' ');
  return s.invoker ? (where ? `${s.invoker} · ${where}` : s.invoker) : where || '–';
}

/** "Slowest interactions by element": p75 INP per element and page, with its phases and the LoAF script. */
export function SlowestInteractions({ groups }: Props) {
  const styles = useStyles2(getStyles);
  return (
    <table className={styles.table} data-testid="slowest-interactions">
      <thead>
        <tr>
          <th>Element</th>
          <th>Page</th>
          <th>Type</th>
          <th className={styles.num}>p75 INP</th>
          <th className={styles.num}>Input delay</th>
          <th className={styles.num}>Processing</th>
          <th className={styles.num}>Presentation</th>
          <th>Script (Long Animation Frame)</th>
          <th className={styles.num}>Page views</th>
          <th className={styles.num}>Sessions</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={`${g.target}|${g.page}`}>
            <td className={styles.mono}>{g.target || <span className={styles.muted}>no target sent</span>}</td>
            <td className={styles.mono}>{g.page || '–'}</td>
            <td>{g.interaction_type ?? '–'}</td>
            <td className={styles.num}>
              <Tooltip content={`${g.rating}, max ${formatMs(g.max_ms)}`}>
                <span className={styles.rating[g.rating] ?? undefined} data-rating={g.rating}>
                  {formatMs(g.p75_ms)}
                </span>
              </Tooltip>
            </td>
            <td className={styles.num}>{formatMs(g.input_delay_p75_ms)}</td>
            <td className={styles.num}>{formatMs(g.processing_duration_p75_ms)}</td>
            <td className={styles.num}>{formatMs(g.presentation_delay_p75_ms)}</td>
            <td className={styles.script} title={g.script?.file}>
              {scriptLabel(g.script)}
              {g.script && g.script.count < g.count ? (
                <span className={styles.muted}>
                  {' '}
                  ({g.script.count} of {g.count})
                </span>
              ) : null}
            </td>
            <td className={styles.num}>{g.count}</td>
            <td className={styles.num}>{g.sessions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
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
  num: css({ textAlign: 'right !important' as 'right', fontVariantNumeric: 'tabular-nums' }),
  mono: css({ fontFamily: theme.typography.fontFamilyMonospace, fontSize: theme.typography.bodySmall.fontSize }),
  script: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    maxWidth: 420,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  muted: css({ color: theme.colors.text.secondary, fontFamily: theme.typography.fontFamily }),
  rating: {
    good: css({ color: theme.colors.success.text }),
    'needs-improvement': css({ color: theme.colors.warning.text }),
    poor: css({ color: theme.colors.error.text, fontWeight: theme.typography.fontWeightMedium }),
  } as Record<string, string>,
});
