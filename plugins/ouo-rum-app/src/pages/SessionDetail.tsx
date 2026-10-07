import React, { useCallback, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Icon, LinkButton, LoadingPlaceholder, Stack, useStyles2 } from '@grafana/ui';
import { useParams } from 'react-router-dom';
import { rumApi } from '../api/client';
import type { TimelineEvent } from '../api/types';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { PlatformIcon } from '../components/PlatformIcon';
import { ReplayMarkers } from '../components/ReplayMarkers';
import { ReplayPlayer, type ReplayHandle } from '../components/ReplayPlayer';
import { StateBadge, StatusBadge } from '../components/StatusBadge';
import { Timeline } from '../components/Timeline';
import { TracesTable } from '../components/TracesTable';
import { useRawRange } from '../components/TimeRangeBar';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useRumQuery } from '../hooks/useRumQuery';
import { formatDateTime, formatDuration, formatTraceCount, parseTs, sessionDurationMs } from '../utils/format';
import { buildMarkers, latestEventIndex, replayBounds, seekOffset } from '../utils/markers';

export default function SessionDetail() {
  const styles = useStyles2(getStyles);
  const { id = '' } = useParams<{ id: string }>();
  const range = useRawRange();

  const detail = useRumQuery(
    () => rumApi.session(id, { from: range.from, to: range.to }),
    `${id}|${range.from}|${range.to}`,
    Boolean(id)
  );
  const session = detail.data;
  const wantsReplay = Boolean(session?.has_replay);
  const replay = useRumQuery(() => rumApi.replayEvents(id), `${id}|replay`, wantsReplay);

  const playerRef = useRef<ReplayHandle | null>(null);
  const [currentMs, setCurrentMs] = useState(0);

  const timeline = useMemo(() => session?.timeline ?? [], [session]);
  const sessionStart = parseTs(session?.started_at);
  const bounds = useMemo(() => replayBounds(replay.data ?? []), [replay.data]);
  const hasReplay = wantsReplay && Boolean(replay.data?.length);
  const markers = useMemo(
    () => (hasReplay ? buildMarkers(timeline, bounds.start, bounds.durationMs) : []),
    [hasReplay, timeline, bounds]
  );
  // While a replay plays, highlight the latest event at or before the cursor; otherwise nothing.
  const activeIndex = hasReplay ? latestEventIndex(timeline, bounds.start, currentMs) : -1;

  const seekTo = useCallback((offsetMs: number) => {
    playerRef.current?.goto(offsetMs);
    setCurrentMs(offsetMs);
  }, []);
  const onTimelineSeek = useCallback(
    (ts: number, _ev: TimelineEvent) => {
      if (!hasReplay) {
        return;
      }
      seekTo(seekOffset(ts, bounds.start, bounds.durationMs));
    },
    [hasReplay, bounds, seekTo]
  );

  const pageNav = {
    text: session ? `Session ${id.slice(0, 8)}…` : 'Session',
    subTitle: id,
    parentItem: { text: 'Sessions', url: `${PLUGIN_BASE_URL}/${ROUTES.Sessions}?from=${range.from}&to=${range.to}` },
  };

  return (
    <PluginPage
      pageNav={pageNav}
      actions={
        <LinkButton
          variant="secondary"
          icon="arrow-left"
          href={`${PLUGIN_BASE_URL}/${ROUTES.Sessions}?from=${range.from}&to=${range.to}`}
        >
          Back to sessions
        </LinkButton>
      }
    >
      {detail.error && <ApiErrorAlert error={detail.error} onRetry={detail.reload} />}
      {detail.loading && !session && <LoadingPlaceholder text="Loading session…" />}
      {session && (
        <>
          <header className={styles.header} data-testid="session-header">
            <div className={styles.headRow}>
              <code className={styles.id}>{session.session_id}</code>
              <StatusBadge status={session.status} />
              <StateBadge state={session.state} endReason={session.end_reason} />
            </div>
            <dl className={styles.meta}>
              <dt>User</dt>
              <dd>{session.user_id || <span className={styles.muted}>anonymous</span>}</dd>
              <dt>Platform</dt>
              <dd>
                <PlatformIcon platform={session.platform} />
              </dd>
              <dt>Service</dt>
              <dd>
                {session.service_name} <span className={styles.muted}>{session.service_version}</span>
              </dd>
              <dt>Started</dt>
              <dd>{formatDateTime(session.started_at)}</dd>
              <dt>{session.ended_at ? 'Ended' : 'Last signal'}</dt>
              <dd>
                {formatDateTime(session.ended_at ?? session.last_signal_at)}
                {session.end_reason && <span className={styles.muted}> · {session.end_reason}</span>}
              </dd>
              <dt>Duration</dt>
              <dd>{session.state === 'active' ? 'active' : formatDuration(sessionDurationMs(session))}</dd>
              <dt>Counts</dt>
              <dd>
                {session.error_count} errors · {session.crash_count} crashes · {session.failed_request_count} failed
                requests · {session.event_count} events · {formatTraceCount(session.trace_count)} traces
              </dd>
            </dl>
          </header>

          <div className={styles.grid}>
            <section className={styles.panel} data-testid="panel-timeline">
              <h4 className={styles.h4}>
                <Icon name="history" /> Timeline <span className={styles.muted}>({timeline.length} events)</span>
              </h4>
              <Timeline
                timeline={timeline}
                sessionStart={sessionStart}
                activeIndex={activeIndex}
                onSeek={hasReplay ? onTimelineSeek : undefined}
              />
            </section>

            <section className={styles.panel} data-testid="panel-replay">
              <h4 className={styles.h4}>
                <Icon name="play" /> Replay
              </h4>
              {!session.has_replay && (
                <div className={styles.muted}>
                  {session.platform === 'mobile'
                    ? 'Mobile sessions have no replay in the MVP.'
                    : 'No replay was recorded for this session.'}
                </div>
              )}
              {wantsReplay && replay.error && <ApiErrorAlert error={replay.error} onRetry={replay.reload} />}
              {wantsReplay && replay.loading && !replay.data && <LoadingPlaceholder text="Loading replay events…" />}
              {hasReplay && replay.data && (
                <>
                  <ReplayPlayer ref={playerRef} events={replay.data} onTime={setCurrentMs} />
                  <ReplayMarkers
                    markers={markers}
                    durationMs={bounds.durationMs}
                    currentMs={currentMs}
                    onSeek={(ms) => seekTo(ms)}
                  />
                  <div className={styles.replayInfo}>
                    {replay.data.length} rrweb events · {formatDuration(bounds.durationMs)} · inputs are masked by the
                    SDK at record time · rendered in a sandboxed iframe
                  </div>
                </>
              )}
              {wantsReplay && replay.data && replay.data.length === 0 && (
                <Alert severity="info" title="Replay is empty">
                  rum-api reports a replay for this session but no events were decodable.
                </Alert>
              )}
            </section>
          </div>

          <section className={styles.panel} data-testid="panel-traces">
            <h4 className={styles.h4}>
              <Stack alignItems="center" gap={1}>
                <Icon name="gf-traces" /> Traces <span className={styles.muted}>({session.traces.length})</span>
              </Stack>
            </h4>
            <TracesTable traces={session.traces} />
          </section>
        </>
      )}
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  header: css({ marginBottom: theme.spacing(2) }),
  headRow: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
    marginBottom: theme.spacing(1),
  }),
  id: css({ fontSize: theme.typography.h4.fontSize }),
  meta: css({
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr max-content 1fr',
    columnGap: theme.spacing(2),
    rowGap: theme.spacing(0.5),
    margin: 0,
    dt: { color: theme.colors.text.secondary },
    dd: { margin: 0 },
  }),
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 2fr) minmax(360px, 3fr)',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
    [theme.breakpoints.down('lg')]: { gridTemplateColumns: '1fr' },
  }),
  panel: css({
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(2),
    minWidth: 0,
  }),
  h4: css({ margin: theme.spacing(0, 0, 1.5), fontSize: theme.typography.h4.fontSize }),
  muted: css({ color: theme.colors.text.secondary }),
  replayInfo: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(1),
  }),
});
