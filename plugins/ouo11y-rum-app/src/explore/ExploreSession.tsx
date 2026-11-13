import React, { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, LoadingPlaceholder, Stack, useStyles2 } from '@grafana/ui';
import { ReplayPlayer, type Event, type ReplaySummary } from '@ouo11y/kit';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useSearchParams } from '../hooks/useSearchParams';
import { bff, useBff } from './bff';
import { ClearanceNote } from './ClearanceNote';
import { duration, time } from './format';

/** One session: its event timeline from Loki and, with replay clearance, its replay from Muninn. */
export default function ExploreSession() {
  const styles = useStyles2(getStyles);
  const { project = '', sessionId = '' } = useParams();
  const search = useSearchParams();
  const from = Number(search.get('from')) || undefined;
  const to = Number(search.get('to')) || undefined;
  const me = useBff(() => bff.me(), 'me');
  const detail = useBff(() => bff.session(project, sessionId, from, to), `${project}/${sessionId}/${from}/${to}`);
  const replays = detail.data?.replays ?? null;
  const [replayId, setReplayId] = useState<string>();
  const replay = replays?.find((r) => r.replay_id === replayId) ?? replays?.[0];

  return (
    <PluginPage>
      <Stack direction="column" gap={2}>
        <Link to={`${PLUGIN_BASE_URL}/${ROUTES.Explore}`}>← Sessions</Link>
        {detail.error && (
          <Alert severity="error" title="Session could not be read">
            {detail.error.message}
          </Alert>
        )}
        {detail.loading && !detail.data && <LoadingPlaceholder text="Loading session…" />}
        {detail.data && (
          <>
            <Stack gap={2} wrap="wrap" alignItems="center">
              <code>{sessionId}</code>
              <span>{project}</span>
              <span>{detail.data.session.service}</span>
              <span>{time(detail.data.session.start)}</span>
              <span>{duration(detail.data.session.end - detail.data.session.start)}</span>
              <span>{detail.data.session.event_count} events</span>
              {detail.data.session.error_count > 0 && <Badge color="red" text={`${detail.data.session.error_count} errors`} />}
              {detail.data.session.user && <Badge color="purple" text={`user ${detail.data.session.user}`} />}
            </Stack>
            <ClearanceNote me={me.data} redacted={detail.data.redacted} />
            {detail.data.truncated && (
              <Alert severity="warning" title="Partial timeline">
                This session has more events than one read returns; the latest ones are not shown.
              </Alert>
            )}
            <div className={styles.columns}>
              <section className={styles.timeline} data-testid="explore-timeline">
                <h4>Timeline</h4>
                <Timeline events={detail.data.events} start={detail.data.session.start} />
              </section>
              <section className={styles.replay}>
                <h4>Replay</h4>
                {replays === null && !detail.data.replays_error && (
                  <div className={styles.muted} data-testid="replay-hidden">
                    Replays are hidden by your clearance.
                  </div>
                )}
                {detail.data.replays_error && (
                  <Alert severity="warning" title="Replays could not be read">
                    {detail.data.replays_error}
                  </Alert>
                )}
                {replays && replays.length === 0 && <div className={styles.muted}>No replay stored for this session.</div>}
                {replays && replays.length > 1 && (
                  <select value={replay?.replay_id} onChange={(e) => setReplayId(e.target.value)}>
                    {replays.map((r) => (
                      <option key={r.replay_id} value={r.replay_id}>
                        {time(r.start_time)}, {r.state}, {r.formats.join(' ')}
                      </option>
                    ))}
                  </select>
                )}
                {replay && <Replay project={project} session={sessionId} replay={replay} />}
              </section>
            </div>
          </>
        )}
      </Stack>
    </PluginPage>
  );
}

function Replay({ project, session, replay }: { project: string; session: string; replay: ReplaySummary }) {
  const manifest = useBff(() => bff.manifest(project, session, replay.replay_id), replay.replay_id);
  const fetchChunk = useMemo(() => bff.chunkFetcher(project, session, replay.replay_id), [project, session, replay.replay_id]);
  if (manifest.error) {
    return (
      <Alert severity="error" title="Replay could not be read">
        {manifest.error.message}
      </Alert>
    );
  }
  if (!manifest.data) {
    return <LoadingPlaceholder text="Loading replay…" />;
  }
  return (
    <>
      <div>
        {replay.state} · {replay.chunk_count} chunks · {replay.formats.join(', ')}
      </div>
      <ReplayPlayer manifest={manifest.data} fetchChunk={fetchChunk} />
    </>
  );
}

function Timeline({ events, start }: { events: Event[]; start: number }) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState<number>();
  return (
    <table className={styles.table}>
      <tbody>
        {events.map((e, i) => (
          <React.Fragment key={i}>
            <tr
              data-testid="timeline-event"
              className={e.attributes || e.body ? styles.clickable : undefined}
              onClick={() => setOpen(open === i ? undefined : i)}
            >
              <td className={styles.muted}>+{duration(e.time - start)}</td>
              <td>{e.name}</td>
              <td>{e.severity && e.severity !== 'INFO' ? <Badge color="red" text={e.severity} /> : null}</td>
            </tr>
            {open === i && (e.attributes || e.body) && (
              <tr>
                <td colSpan={3}>
                  <pre className={styles.attrs}>
                    {Object.entries(e.attributes ?? {})
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n')}
                    {e.body ? `\n\n${e.body}` : ''}
                  </pre>
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  columns: css({
    display: 'grid',
    gap: theme.spacing(2),
    gridTemplateColumns: 'minmax(280px, 2fr) 3fr',
    [theme.breakpoints.down('lg')]: { gridTemplateColumns: '1fr' },
  }),
  timeline: css({ maxHeight: '75vh', overflowY: 'auto' }),
  replay: css({ minWidth: 0 }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    td: { padding: theme.spacing(0.5, 1), borderBottom: `1px solid ${theme.colors.border.weak}`, verticalAlign: 'top' },
  }),
  clickable: css({ cursor: 'pointer', '&:hover': { background: theme.colors.action.hover } }),
  muted: css({ color: theme.colors.text.secondary }),
  attrs: css({ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: theme.typography.bodySmall.fontSize }),
});
