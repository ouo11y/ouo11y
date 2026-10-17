import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import type { HealthBucket } from '../api/types';
import { formatPct } from '../utils/format';

export interface Tile {
  label: string;
  pct: number;
  count: number;
  color: string;
}

export function healthColors(theme: GrafanaTheme2) {
  return {
    healthy: theme.colors.success.main,
    errored: theme.colors.warning.main,
    crashed: theme.colors.error.main,
  };
}

export function tilesFromBucket(b: HealthBucket, colors: ReturnType<typeof healthColors>): Tile[] {
  return [
    { label: 'Healthy', pct: b.healthy_pct, count: b.healthy, color: colors.healthy },
    { label: 'Errored', pct: b.errored_pct, count: b.errored, color: colors.errored },
    { label: 'Crashed', pct: b.crashed_pct, count: b.crashed, color: colors.crashed },
  ];
}

export function HealthTiles({ bucket, total }: { bucket: HealthBucket; total: number }) {
  const styles = useStyles2(getStyles);
  const colors = useStyles2(healthColors);
  const tiles = tilesFromBucket(bucket, colors);
  return (
    <div className={styles.grid} data-testid="health-tiles">
      {tiles.map((t) => (
        <div key={t.label} className={styles.tile} style={{ borderTopColor: t.color }}>
          <div className={styles.label}>{t.label}</div>
          <div className={styles.value} style={{ color: t.color }}>
            {formatPct(t.pct)}
          </div>
          <div className={styles.sub}>
            {t.count} of {total} session{total === 1 ? '' : 's'}
          </div>
        </div>
      ))}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  }),
  tile: css({
    background: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderTop: '3px solid',
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1.5, 2),
  }),
  label: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }),
  value: css({
    fontSize: theme.typography.h1.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    lineHeight: 1.2,
    margin: theme.spacing(0.5, 0),
  }),
  sub: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
