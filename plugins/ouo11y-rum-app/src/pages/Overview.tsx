import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { EmptyState, Icon, LinkButton, LoadingPlaceholder, Stack, useStyles2 } from '@grafana/ui';
import { rumApi } from '../api/client';
import type { HealthBucket } from '../api/types';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { HealthTiles } from '../components/HealthTiles';
import { TimeRangeBar, useRawRange } from '../components/TimeRangeBar';
import { VersionTable } from '../components/VersionTable';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useRumQuery } from '../hooks/useRumQuery';
import { pct } from '../utils/format';

const PLATFORMS: Array<{ id: 'web' | 'mobile'; title: string; icon: 'globe' | 'mobile-android' }> = [
  { id: 'web', title: 'Web', icon: 'globe' },
  { id: 'mobile', title: 'Mobile', icon: 'mobile-android' },
];

/** Sums the buckets of one platform; percentages recomputed the way rum-api rounds. */
export function platformTotals(platform: string, buckets: HealthBucket[]): HealthBucket {
  const rows = buckets.filter((b) => b.platform === platform);
  const sum = rows.reduce(
    (acc, b) => {
      acc.total += b.total;
      acc.healthy += b.healthy;
      acc.errored += b.errored;
      acc.crashed += b.crashed;
      return acc;
    },
    { total: 0, healthy: 0, errored: 0, crashed: 0 }
  );
  return {
    platform,
    service_name: '',
    service_version: '',
    ...sum,
    healthy_pct: pct(sum.healthy, sum.total),
    errored_pct: pct(sum.errored, sum.total),
    crashed_pct: pct(sum.crashed, sum.total),
  };
}

export function sessionsLink(b: HealthBucket, range: { from: string; to: string }): string {
  const q = new URLSearchParams({ from: range.from, to: range.to, platform: b.platform });
  if (b.service_name) {
    q.set('service', b.service_name);
  }
  if (b.service_version) {
    q.set('version', b.service_version);
  }
  if (b.bundle_id) {
    q.set('bundle', b.bundle_id);
  }
  return `${PLUGIN_BASE_URL}/${ROUTES.Sessions}?${q.toString()}`;
}

export default function Overview() {
  const styles = useStyles2(getStyles);
  const range = useRawRange();
  const key = `${range.from}|${range.to}`;
  const { data, error, loading, reload } = useRumQuery(() => rumApi.health({ from: range.from, to: range.to }), key);
  const buckets = useMemo(() => data?.buckets ?? [], [data]);

  return (
    <PluginPage
      actions={
        <Stack gap={1} alignItems="center">
          <TimeRangeBar />
        </Stack>
      }
      subTitle="Healthy, errored and crashed sessions by platform, version and OTA bundle, as classified by rum-api."
    >
      {error && <ApiErrorAlert error={error} onRetry={reload} />}
      {loading && !data && <LoadingPlaceholder text="Loading session health…" />}
      {data && data.totals.total === 0 && !error && (
        <EmptyState variant="not-found" message="No sessions in this time range">
          Widen the time range or produce traffic with the demo apps. rum-api folds session events from Loki on demand.
        </EmptyState>
      )}
      {data && data.totals.total > 0 && (
        <div className={styles.platforms}>
          {PLATFORMS.map((p) => {
            const totals = platformTotals(p.id, buckets);
            const rows = buckets.filter((b) => b.platform === p.id);
            return (
              <section key={p.id} className={styles.section} data-testid={`platform-${p.id}`}>
                <div className={styles.header}>
                  <h3 className={styles.h3}>
                    <Icon name={p.icon} size="lg" /> {p.title}
                    <span className={styles.count}>
                      {totals.total} session{totals.total === 1 ? '' : 's'}
                    </span>
                  </h3>
                  <LinkButton
                    size="sm"
                    variant="secondary"
                    href={sessionsLink({ ...totals, service_name: '', service_version: '' }, range)}
                  >
                    All {p.id} sessions
                  </LinkButton>
                </div>
                {totals.total === 0 ? (
                  <div className={styles.none}>No {p.id} sessions in this range.</div>
                ) : (
                  <>
                    <HealthTiles bucket={totals} total={totals.total} />
                    <VersionTable buckets={rows} sessionsHref={(b) => sessionsLink(b, range)} />
                  </>
                )}
              </section>
            );
          })}
          <div className={styles.footer}>
            All platforms: {data.totals.total} sessions, {data.totals.healthy} healthy / {data.totals.errored} errored /{' '}
            {data.totals.crashed} crashed ({data.from} → {data.to}).
          </div>
        </div>
      )}
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  platforms: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(3) }),
  section: css({
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(2),
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(1.5),
  }),
  h3: css({
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    fontSize: theme.typography.h3.fontSize,
  }),
  count: css({ color: theme.colors.text.secondary, fontSize: theme.typography.body.fontSize, fontWeight: 'normal' }),
  none: css({ color: theme.colors.text.secondary }),
  footer: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
});
