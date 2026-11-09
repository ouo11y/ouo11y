import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Tooltip, useStyles2 } from '@grafana/ui';
import { Link } from 'react-router-dom';
import type { HealthBucket } from '../api/types';
import { formatPct } from '../utils/format';
import { healthColors } from './HealthTiles';

interface Props {
  buckets: HealthBucket[];
  /** Builds the Sessions page link for a bucket. */
  sessionsHref: (bucket: HealthBucket) => string;
}

export function VersionTable({ buckets, sessionsHref }: Props) {
  const styles = useStyles2(getStyles);
  const colors = useStyles2(healthColors);
  // OTA bundles (React Native): one row per version × bundle; the column shows only when one has a bundle.
  const bundles = buckets.some((b) => b.bundle_id);
  return (
    <table className={styles.table} data-testid="version-table">
      <thead>
        <tr>
          <th>Service</th>
          <th>Version</th>
          {bundles && <th>Bundle</th>}
          <th className={styles.num}>Total</th>
          <th className={styles.num}>Healthy</th>
          <th className={styles.num}>Errored</th>
          <th className={styles.num}>Crashed</th>
          <th className={styles.barCol}>Split</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={`${b.platform}|${b.service_name}|${b.service_version}|${b.bundle_id ?? ''}`}>
            <td>
              <Link className={styles.link} to={sessionsHref(b)}>
                {b.service_name || '–'}
              </Link>
            </td>
            <td>
              <Link className={styles.link} to={sessionsHref(b)}>
                {b.service_version || '–'}
              </Link>
            </td>
            {bundles && (
              <td data-testid="version-table-bundle">
                {b.bundle_id ? (
                  <Link className={styles.link} to={sessionsHref(b)}>
                    <code>{b.bundle_id}</code>
                  </Link>
                ) : (
                  <span className={styles.pct}>embedded / none</span>
                )}
              </td>
            )}
            <td className={styles.num}>{b.total}</td>
            <td className={styles.num}>
              {b.healthy} <span className={styles.pct}>({formatPct(b.healthy_pct)})</span>
            </td>
            <td className={styles.num}>
              {b.errored} <span className={styles.pct}>({formatPct(b.errored_pct)})</span>
            </td>
            <td className={styles.num}>
              {b.crashed} <span className={styles.pct}>({formatPct(b.crashed_pct)})</span>
            </td>
            <td className={styles.barCol}>
              <div
                className={styles.bar}
                role="img"
                aria-label={`healthy ${b.healthy_pct}%, errored ${b.errored_pct}%, crashed ${b.crashed_pct}%`}
              >
                {(
                  [
                    ['healthy', b.healthy_pct, colors.healthy],
                    ['errored', b.errored_pct, colors.errored],
                    ['crashed', b.crashed_pct, colors.crashed],
                  ] as const
                ).map(([name, pct, color]) =>
                  pct > 0 ? (
                    <Tooltip key={name} content={`${name} ${formatPct(pct)}`}>
                      <div className={styles.segment} style={{ width: `${pct}%`, background: color }} />
                    </Tooltip>
                  ) : null
                )}
              </div>
            </td>
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
  pct: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  barCol: css({ width: '35%' }),
  bar: css({
    display: 'flex',
    height: 14,
    width: '100%',
    background: theme.colors.background.canvas,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
  segment: css({ height: '100%' }),
  link: css({ color: theme.colors.text.link, '&:hover': { textDecoration: 'underline' } }),
});
