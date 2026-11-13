import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, EmptyState, LoadingPlaceholder, Select, Stack, useStyles2 } from '@grafana/ui';
import { FunnelChart, formatTime, type Outcome } from '@ouo11y/kit';
import { bff, useBff } from './bff';
import { ClearanceNote } from './ClearanceNote';
import { sessionHref } from './ExploreSessions';
import { KitTheme } from './KitTheme';
import { ScopeBar, useScope } from './ScopeBar';

/**
 * Business flows: the provisioned funnels (ADR-0025) over web and mobile sessions. Counts are
 * visible from c1; a click on a drop-off lists the sessions that stopped there, each a link to
 * its timeline and replay (which follow the session rules of the caller's clearance).
 */
export default function Flows() {
  const styles = useStyles2(getStyles);
  const ctl = useScope();
  const me = useBff(() => bff.me(), 'me');
  const list = useBff(() => bff.funnels(), 'funnels');
  const [picked, setPicked] = useState<string>();
  const funnelId = picked ?? list.data?.funnels[0]?.id;
  const report = useBff(() => bff.funnel(funnelId!, ctl.scope), funnelId ? `${funnelId}/${ctl.key}` : null);
  const [drop, setDrop] = useState<{ step: number; outcome?: Outcome }>();
  const dropKey = funnelId && drop ? `${funnelId}/${ctl.key}/${drop.step}/${drop.outcome ?? ''}` : null;
  const dropped = useBff(
    () => bff.funnelDropped(funnelId!, drop!.step, { ...ctl.scope, outcome: drop!.outcome }),
    dropKey
  );

  return (
    <PluginPage>
      <Stack direction="column" gap={2}>
        <Stack justifyContent="space-between" alignItems="center" wrap="wrap">
          <Stack gap={1} wrap="wrap" alignItems="center">
            {list.data && list.data.funnels.length > 0 && (
              <Select
                width={32}
                aria-label="Funnel"
                options={list.data.funnels.map((f) => ({ label: f.name, value: f.id, description: f.description }))}
                value={funnelId}
                onChange={(v) => {
                  setPicked(v.value);
                  setDrop(undefined);
                }}
              />
            )}
            <ScopeBar ctl={ctl} />
          </Stack>
          {me.data && <Badge color="blue" text={`Clearance c${me.data.level}`} />}
        </Stack>
        {list.data?.invalid?.map((m) => (
          <Alert key={m} severity="warning" title="A provisioned funnel is invalid and was skipped">
            {m}
          </Alert>
        ))}
        {(list.error || report.error) && (
          <Alert severity="error" title="The funnel could not be read">
            {(list.error ?? report.error)?.message}
          </Alert>
        )}
        {list.data && list.data.funnels.length === 0 && (
          <EmptyState variant="call-to-action" message="No funnels are provisioned">
            Add funnel definitions to the plugin settings (<code>jsonData.funnels</code>), see ADR-0025.
          </EmptyState>
        )}
        {report.loading && !report.data && <LoadingPlaceholder text="Counting sessions…" />}
        {report.data?.truncated && (
          <Alert severity="warning" title="Partial counts">
            The range holds more records than one read covers; the end of the range is undercounted.
          </Alert>
        )}
        {report.data && (
          <div className={styles.columns}>
            <section>
              {report.data.funnel.description && <p className={styles.muted}>{report.data.funnel.description}</p>}
              <KitTheme>
                <FunnelChart
                  report={report.data}
                  selected={drop}
                  onDropOff={(step, outcome) => setDrop({ step, outcome })}
                />
              </KitTheme>
            </section>
            <section data-testid="funnel-dropped-list">
              {!drop && <div className={styles.muted}>Click a drop-off to list the sessions that stopped there.</div>}
              {drop && (
                <>
                  <h4>
                    {dropped.data?.total ?? ''} sessions {drop.outcome ?? 'dropped'} before step {drop.step},{' '}
                    {report.data.steps[drop.step - 1]?.step.label}
                  </h4>
                  <ClearanceNote me={me.data} redacted={dropped.data?.redacted} />
                  {dropped.loading && <LoadingPlaceholder text="Loading sessions…" />}
                  {dropped.error && <Alert severity="error" title={dropped.error.message} />}
                  {dropped.data && (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Last step at</th>
                          <th>Platform</th>
                          <th>Outcome</th>
                          <th>User</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dropped.data.sessions.map((s) => (
                          <tr key={`${s.project}/${s.id}`}>
                            <td>
                              <Link
                                to={sessionHref(s.project, s.id, report.data!.from, report.data!.to)}
                                data-testid="dropped-session-link"
                              >
                                {formatTime(s.last_step_at)}
                              </Link>
                            </td>
                            <td>{s.platform}</td>
                            <td>
                              {s.outcome === 'failed' ? (
                                <Badge color="red" text={`failed: ${s.failed_with}`} />
                              ) : (
                                'abandoned'
                              )}
                            </td>
                            <td>
                              {s.user ?? (me.data?.can.identity ? '' : <span className={styles.muted}>hidden</span>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </Stack>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  columns: css({
    display: 'grid',
    gap: theme.spacing(3),
    gridTemplateColumns: '3fr 2fr',
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
