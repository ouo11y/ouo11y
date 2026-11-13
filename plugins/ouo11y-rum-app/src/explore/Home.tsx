import React from 'react';
import { Link } from 'react-router-dom';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, LoadingPlaceholder, Stack, useStyles2 } from '@grafana/ui';
import { formatTime, formatValue, type HealthRow, type TimeSeries, type Vital } from '@ouo11y/kit';
import { bff, useBff } from './bff';
import { ClearanceNote } from './ClearanceNote';
import { sessionHref } from './ExploreSessions';
import { ScopeBar, useScope } from './ScopeBar';

const VITAL_LABEL: Record<string, string> = {
  lcp: 'LCP',
  inp: 'INP',
  cls: 'CLS',
  fcp: 'FCP',
  ttfb: 'TTFB',
  app_start_cold: 'Cold start',
  app_start_warm: 'Warm start',
  ttid: 'Time to initial display',
  slow_frames: 'Slow frames',
  frozen_frames: 'Frozen frames',
};

/** Landing page on the spec wire: health, sessions over time, top errors, vitals and the backend. */
export default function Home() {
  const styles = useStyles2(getStyles);
  const ctl = useScope();
  const me = useBff(() => bff.me(), 'me');
  const ov = useBff(() => bff.overview(ctl.scope), ctl.key);
  const d = ov.data;
  return (
    <PluginPage>
      <Stack direction="column" gap={2}>
        <Stack justifyContent="space-between" alignItems="center" wrap="wrap">
          <ScopeBar ctl={ctl} />
          {me.data && <Badge color="blue" text={`Clearance c${me.data.level}`} />}
        </Stack>
        <ClearanceNote me={me.data} redacted={d?.redacted} />
        {ov.error && (
          <Alert severity="error" title="The overview could not be read">
            {ov.error.message}
          </Alert>
        )}
        {ov.loading && !d && <LoadingPlaceholder text="Loading the overview…" />}
        {d?.truncated && (
          <Alert severity="warning" title="Partial numbers">
            The range holds more records than one read covers; the oldest part is not counted. Narrow the range.
          </Alert>
        )}
        {d && (
          <>
            <div className={styles.tiles} data-testid="home-health">
              <Tile label="Session health" value={`${d.totals.health} %`} hint="sessions with no error or crash" />
              <Tile label="Crash-free" value={`${d.totals.crash_free} %`} hint="sessions with no crash" />
              <Tile label="Sessions" value={String(d.totals.sessions)} hint="started in the range" />
              <Tile label="With errors" value={String(d.totals.errored)} hint={`${d.totals.crashed} crashed`} />
            </div>
            <div className={styles.grid}>
              <section>
                <h4>Sessions over time</h4>
                <SessionsChart series={d.sessions_over_time} />
              </section>
              <section>
                <h4>By project and platform</h4>
                <HealthTable rows={d.health} />
              </section>
            </div>
            <section>
              <h4>Top errors</h4>
              {d.top_errors.length === 0 ? (
                <div className={styles.muted}>No errors in this range.</div>
              ) : (
                <table className={styles.table} data-testid="home-errors">
                  <thead>
                    <tr>
                      <th>Error</th>
                      <th>Project</th>
                      <th>Platforms</th>
                      <th>Sessions</th>
                      <th>Count</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.top_errors.map((e) => (
                      <tr key={`${e.project}/${e.fingerprint}`}>
                        <td>
                          {e.fatal && <Badge color="red" text="crash" />}{' '}
                          {e.type || e.message ? (
                            `${e.type ?? ''}${e.message ? `: ${e.message}` : ''}`
                          ) : (
                            <code>{e.fingerprint}</code>
                          )}
                        </td>
                        <td>{e.project}</td>
                        <td>{e.platforms.join(', ')}</td>
                        <td>{e.sessions}</td>
                        <td>{e.count}</td>
                        <td>
                          <Link to={sessionHref(e.project, e.session, d.from, d.to)}>{formatTime(e.last_seen)}</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <div className={styles.grid}>
              <section data-testid="home-web-vitals">
                <h4>Web vitals (p75)</h4>
                <Vitals vitals={d.web_vitals} empty="No web vitals in this range." />
              </section>
              <section data-testid="home-mobile-vitals">
                <h4>Mobile vitals (p75; frames as a share of frames drawn)</h4>
                <Vitals vitals={d.mobile_vitals} empty="No mobile vitals in this range." />
              </section>
            </div>
            <section data-testid="home-backend">
              <h4>Backend services (Mimir, from Tempo span metrics)</h4>
              {d.backend_error && <Alert severity="warning" title={d.backend_error} />}
              {d.backend && d.backend.length === 0 && (
                <div className={styles.muted}>No server spans in this range.</div>
              )}
              {d.backend && d.backend.length > 0 && (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Requests / s</th>
                      <th>Errors</th>
                      <th>p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.backend.map((s) => (
                      <tr key={s.service}>
                        <td>{s.service}</td>
                        <td>{s.rate_per_sec}</td>
                        <td>{s.error_pct} %</td>
                        <td>{s.p95_ms === null ? '' : formatValue(s.p95_ms, 'ms')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </Stack>
    </PluginPage>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.tile}>
      <div className={styles.muted}>{label}</div>
      <div className={styles.big}>{value}</div>
      <div className={styles.muted}>{hint}</div>
    </div>
  );
}

function HealthTable({ rows }: { rows: HealthRow[] }) {
  const styles = useStyles2(getStyles);
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Project</th>
          <th>Platform</th>
          <th>Sessions</th>
          <th>Health</th>
          <th>Crash-free</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.project}/${r.platform}`}>
            <td>{r.project}</td>
            <td>{r.platform}</td>
            <td>{r.sessions}</td>
            <td>{r.health} %</td>
            <td>{r.crash_free} %</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Vitals({ vitals, empty }: { vitals: Vital[]; empty: string }) {
  const styles = useStyles2(getStyles);
  if (vitals.length === 0) {
    return <div className={styles.muted}>{empty}</div>;
  }
  return (
    <table className={styles.table}>
      <tbody>
        {vitals.map((v) => (
          <tr key={`${v.platform}/${v.name}`}>
            <td>{VITAL_LABEL[v.name] ?? v.name}</td>
            <td>{v.platform}</td>
            <td>{formatValue(v.p75, v.unit)}</td>
            <td className={styles.muted}>{v.unit === '%' ? `${v.count} frames` : `${v.count} samples`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const COLORS = ['#5794F2', '#73BF69', '#FF9830', '#B877D9', '#F2495C'];

/** Stacked columns of sessions started per bucket, one colour per platform. */
function SessionsChart({ series }: { series: TimeSeries[] }) {
  const styles = useStyles2(getStyles);
  if (series.length === 0) {
    return <div className={styles.muted}>No sessions started in this range.</div>;
  }
  const n = series[0].points.length;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.points[i]?.[1] ?? 0), 0));
  const top = Math.max(1, ...totals);
  const w = 600;
  const h = 140;
  const bw = w / n;
  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        role="img"
        aria-label="Sessions over time"
        data-testid="home-sessions-chart"
      >
        {Array.from({ length: n }, (_, i) => {
          let y = h;
          return series.map((s, j) => {
            const v = s.points[i]?.[1] ?? 0;
            const bh = (v / top) * (h - 10);
            y -= bh;
            return v > 0 ? (
              <rect
                key={`${i}/${j}`}
                x={i * bw + 1}
                y={y}
                width={Math.max(bw - 2, 1)}
                height={bh}
                fill={COLORS[j % COLORS.length]}
              >
                <title>{`${formatTime(s.points[i][0])} ${s.platform}: ${v}`}</title>
              </rect>
            ) : null;
          });
        })}
      </svg>
      <Stack gap={2}>
        {series.map((s, j) => (
          <span key={s.platform}>
            <span style={{ color: COLORS[j % COLORS.length] }}>■</span> {s.platform} (
            {s.points.reduce((a, p) => a + p[1], 0)})
          </span>
        ))}
      </Stack>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  tiles: css({ display: 'grid', gap: theme.spacing(2), gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }),
  tile: css({
    padding: theme.spacing(2),
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
  }),
  big: css({ fontSize: theme.typography.h2.fontSize, fontWeight: theme.typography.fontWeightMedium }),
  grid: css({
    display: 'grid',
    gap: theme.spacing(3),
    gridTemplateColumns: '1fr 1fr',
    [theme.breakpoints.down('lg')]: { gridTemplateColumns: '1fr' },
  }),
  muted: css({ color: theme.colors.text.secondary }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.5, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
    },
    th: { color: theme.colors.text.secondary, fontWeight: theme.typography.fontWeightMedium },
  }),
});
