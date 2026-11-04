import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Tooltip, useStyles2 } from '@grafana/ui';
import { Link } from 'react-router-dom';
import type { HealthApp } from '../api/types';
import type { Scope } from '../hooks/useScope';
import { formatPct, pct } from '../utils/format';
import { healthColors } from './HealthTiles';
import { PlatformIcon } from './PlatformIcon';

export interface ProjectHealth {
  project_id: string;
  apps: HealthApp[];
  total: number;
  healthy: number;
  errored: number;
  crashed: number;
  healthy_pct: number;
  errored_pct: number;
  crashed_pct: number;
}

/**
 * Groups the health `apps` rows by project, projects in rum-api order (by id), with project
 * totals recomputed the way rum-api rounds. Rows without a project are grouped under "".
 */
export function groupByProject(apps: HealthApp[]): ProjectHealth[] {
  const out: ProjectHealth[] = [];
  for (const a of apps) {
    let p = out.find((x) => x.project_id === a.project_id);
    if (!p) {
      p = {
        project_id: a.project_id,
        apps: [],
        total: 0,
        healthy: 0,
        errored: 0,
        crashed: 0,
        healthy_pct: 0,
        errored_pct: 0,
        crashed_pct: 0,
      };
      out.push(p);
    }
    p.apps.push(a);
    p.total += a.total;
    p.healthy += a.healthy;
    p.errored += a.errored;
    p.crashed += a.crashed;
  }
  for (const p of out) {
    p.healthy_pct = pct(p.healthy, p.total);
    p.errored_pct = pct(p.errored, p.total);
    p.crashed_pct = pct(p.crashed, p.total);
  }
  return out;
}

interface Props {
  apps: HealthApp[];
  /** Link that scopes the current page to a project or app. */
  scopeHref: (scope: Scope) => string;
}

/** Health per project and app side by side: the cross-project overview. */
export function ProjectHealthGrid({ apps, scopeHref }: Props) {
  const styles = useStyles2(getStyles);
  const colors = useStyles2(healthColors);
  const projects = groupByProject(apps);
  const bar = (h: { total: number; healthy: number; errored: number; crashed: number }) => (
    <div className={styles.bar} aria-hidden>
      {(['healthy', 'errored', 'crashed'] as const).map((k) =>
        h[k] > 0 ? <span key={k} style={{ flexGrow: h[k], background: colors[k] }} /> : null
      )}
    </div>
  );
  return (
    <div className={styles.grid} data-testid="project-health-grid">
      {projects.map((p) => (
        <section key={p.project_id} className={styles.card} data-testid={`project-${p.project_id || 'none'}`}>
          <header className={styles.head}>
            {p.project_id ? (
              <Link className={styles.project} to={scopeHref({ project: p.project_id, service: '' })}>
                {p.project_id}
              </Link>
            ) : (
              <Tooltip content="Sessions ingested without ouo.project.id. The selector cannot narrow to them.">
                <span className={styles.project}>no project</span>
              </Tooltip>
            )}
            <span className={styles.muted}>
              {p.total} session{p.total === 1 ? '' : 's'} · {p.apps.length} app{p.apps.length === 1 ? '' : 's'}
            </span>
          </header>
          <div className={styles.headline}>
            <span style={{ color: colors.healthy }}>{formatPct(p.healthy_pct)} healthy</span>
            <span style={{ color: colors.errored }}>{formatPct(p.errored_pct)} errored</span>
            <span style={{ color: colors.crashed }}>{formatPct(p.crashed_pct)} crashed</span>
          </div>
          {bar(p)}
          <table className={styles.table}>
            <thead>
              <tr>
                <th>App</th>
                <th>Platform</th>
                <th className={styles.num}>Sessions</th>
                <th className={styles.num}>Healthy</th>
                <th className={styles.num}>Errored</th>
                <th className={styles.num}>Crashed</th>
              </tr>
            </thead>
            <tbody>
              {p.apps.map((a) => (
                <tr key={a.service_name} data-testid={`app-${p.project_id || 'none'}-${a.service_name}`}>
                  <td>
                    {p.project_id ? (
                      <Link className={styles.link} to={scopeHref({ project: p.project_id, service: a.service_name })}>
                        {a.service_name || '–'}
                      </Link>
                    ) : (
                      a.service_name || '–'
                    )}
                  </td>
                  <td>
                    {a.platforms.map((pl) => (
                      <PlatformIcon key={pl} platform={pl} />
                    ))}
                  </td>
                  <td className={styles.num}>{a.total}</td>
                  <td className={styles.num} style={{ color: colors.healthy }}>
                    {formatPct(a.healthy_pct)}
                  </td>
                  <td className={styles.num} style={{ color: colors.errored }}>
                    {formatPct(a.errored_pct)}
                  </td>
                  <td className={styles.num} style={{ color: colors.crashed }}>
                    {formatPct(a.crashed_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 520px), 1fr))',
    gap: theme.spacing(2),
  }),
  card: css({
    overflowX: 'auto',
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(2),
  }),
  head: css({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.spacing(1) }),
  project: css({ fontSize: theme.typography.h4.fontSize, fontWeight: theme.typography.fontWeightMedium }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  headline: css({
    display: 'flex',
    gap: theme.spacing(2),
    margin: theme.spacing(1, 0, 0.5),
    fontWeight: theme.typography.fontWeightMedium,
  }),
  bar: css({
    display: 'flex',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    background: theme.colors.background.secondary,
    marginBottom: theme.spacing(1.5),
  }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.5, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      whiteSpace: 'nowrap',
    },
    th: { textAlign: 'left', color: theme.colors.text.secondary, fontWeight: 'normal' },
  }),
  num: css({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }),
  link: css({ color: theme.colors.text.link }),
});
