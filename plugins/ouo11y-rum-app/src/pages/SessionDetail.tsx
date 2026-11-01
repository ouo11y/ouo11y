import React, { useCallback, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, Icon, LinkButton, LoadingPlaceholder, Stack, useStyles2, useTheme2 } from '@grafana/ui';
import { useParams } from 'react-router-dom';
import { rumApi } from '../api/client';
import type { TimelineEvent } from '../api/types';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { FeedbackList } from '../components/FeedbackList';
import { FramePlayer } from '../components/FramePlayer';
import { LogsPanel } from '../components/LogsPanel';
import { PlatformIcon } from '../components/PlatformIcon';
import { ReplayActivity } from '../components/ReplayActivity';
import { ReplayMarkers } from '../components/ReplayMarkers';
import { ReplayPlayer, type ReplayHandle } from '../components/ReplayPlayer';
import { StateBadge, StatusBadge } from '../components/StatusBadge';
import { Timeline, ratingColor } from '../components/Timeline';
import { TracesTable } from '../components/TracesTable';
import { VideoPlayer } from '../components/VideoPlayer';
import { useRawRange } from '../components/TimeRangeBar';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useRumQuery } from '../hooks/useRumQuery';
import { formatDateTime, formatDuration, formatTraceCount, parseTs, sessionDurationMs } from '../utils/format';
import { framesBounds, replayRenderer } from '../utils/frames';
import { totalFrames, videoBounds } from '../utils/video';
import { buildMarkers, latestEventIndex, replayBounds, seekOffset } from '../utils/markers';
import { buildActivity } from '../utils/activity';
import { buildFeedback } from '../utils/feedback';
import { buildTaps } from '../utils/taps';
import { useFeatureToggle } from '../featureToggles';
import { maskingState, type MaskingState } from '../utils/masking';
import { clampToSessionStart, previousSessionId, sessionContextFields } from '../utils/session';
import { isVitalEvent, vitalsHeaderItems } from '../utils/vitals';

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
  // Logs load after the session is known (the endpoint searches the session's window and traces).
  const logs = useRumQuery(
    () => rumApi.logs(id, { from: range.from, to: range.to }),
    `${id}|logs|${range.from}|${range.to}`,
    Boolean(session)
  );
  // Mobile vitals (docs/specs/mobile-vitals.md): only asked for when the timeline has vital records.
  const hasVitals = Boolean(session?.timeline.some(isVitalEvent));
  const vitals = useRumQuery(
    () => rumApi.vitals(id, { from: range.from, to: range.to }),
    `${id}|vitals|${range.from}|${range.to}`,
    hasVitals
  );
  const vitalsItems = hasVitals ? vitalsHeaderItems(vitals.data) : [];
  const wantsReplay = Boolean(session?.has_replay);
  // The renderer comes from `replay_kind` on the record (older records need the replay meta); the
  // meta is loaded for every replay anyway, for its `masked` flag.
  const meta = useRumQuery(() => rumApi.replayMeta(id), `${id}|replay-meta`, wantsReplay);
  const showTimeline = useFeatureToggle('sessionTimelinePanel');
  const renderer = replayRenderer(session, meta.data);
  const replay = useRumQuery(() => rumApi.replayEvents(id), `${id}|replay`, renderer === 'rrweb');
  const frames = useRumQuery(() => rumApi.replayFrames(id), `${id}|replay-frames`, renderer === 'frames');
  const video = useRumQuery(() => rumApi.replayVideo(id), `${id}|replay-video`, renderer === 'video');

  const playerRef = useRef<ReplayHandle | null>(null);
  const [currentMs, setCurrentMs] = useState(0);

  const sessionStart = parseTs(session?.started_at);
  // Nothing before the session start (C4): early events are moved to it.
  const timeline = useMemo(() => clampToSessionStart(session?.timeline ?? [], sessionStart), [session, sessionStart]);
  const bounds = useMemo(
    () =>
      renderer === 'frames'
        ? framesBounds(frames.data)
        : renderer === 'video'
          ? videoBounds(video.data)
          : replayBounds(replay.data ?? []),
    [renderer, frames.data, video.data, replay.data]
  );
  const hasRrweb = renderer === 'rrweb' && Boolean(replay.data?.length);
  const hasFrames = renderer === 'frames' && Boolean(frames.data?.frames.length);
  const hasVideo = renderer === 'video' && Boolean(video.data?.segments?.length);
  const hasReplay = hasRrweb || hasFrames || hasVideo;
  // A failed meta request only matters when the renderer depended on it.
  const metaError = renderer === undefined ? meta.error : undefined;
  const replayError = replay.error ?? frames.error ?? video.error ?? metaError;
  const replayLoading =
    wantsReplay && !hasReplay && !replayError && (meta.loading || replay.loading || frames.loading || video.loading);
  // Phone replays (frames, video): taps merged from the recording's touches and the `ui.tap`
  // breadcrumbs (C3: frames replays count their touches as taps too).
  const taps = useMemo(() => {
    if (hasVideo && video.data) {
      return buildTaps(video.data.touches ?? [], timeline);
    }
    if (hasFrames && frames.data) {
      return buildTaps(frames.data.touches ?? [], timeline);
    }
    return undefined;
  }, [hasVideo, video.data, hasFrames, frames.data, timeline]);
  const tapTimes = useMemo(
    () => new Map((taps ?? []).filter((t) => t.timelineIndex !== undefined).map((t) => [t.timelineIndex!, t.ts])),
    [taps]
  );
  // One clock (F4): every time on the page is relative to the session start; the players add the
  // replay's offset from it to their labels.
  const clockStart = Number.isFinite(sessionStart) ? sessionStart : bounds.start;
  const clockOffsetMs = Number.isFinite(bounds.start) && Number.isFinite(clockStart) ? bounds.start - clockStart : 0;
  const markers = useMemo(
    () => (hasReplay ? buildMarkers(timeline, bounds.start, bounds.durationMs, taps) : []),
    [hasReplay, timeline, bounds, taps]
  );
  // The activity list: beside every player, and on its own without a replay unless the Timeline
  // panel (feature toggle sessionTimelinePanel) already lists the events.
  const activityStart = hasReplay ? bounds.start : sessionStart;
  const activity = useMemo(() => buildActivity(timeline, activityStart, taps), [timeline, activityStart, taps]);
  const showActivity = hasReplay || (!showTimeline && !replayLoading);
  const feedback = useMemo(() => buildFeedback(timeline, frames.data?.frames), [timeline, frames.data]);
  const masking = maskingState(meta.data);
  const contextFields = session ? sessionContextFields(session) : [];
  const previousId = previousSessionId(session?.timeline ?? []);
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

  // The Logs panel is below the fold: seek, then bring the replay into view.
  const replayPanelRef = useRef<HTMLElement | null>(null);
  const onLogSeek = useCallback(
    (ts: number) => {
      seekTo(seekOffset(ts, bounds.start, bounds.durationMs));
      replayPanelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    [bounds, seekTo]
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
              {previousId && (
                <>
                  <dt>Previous session</dt>
                  <dd>
                    <a
                      className={styles.link}
                      href={`${PLUGIN_BASE_URL}/${ROUTES.Sessions}/${encodeURIComponent(previousId)}?from=${range.from}&to=${range.to}`}
                      data-testid="session-previous"
                    >
                      <code>{previousId.slice(0, 8)}…</code>
                    </a>
                  </dd>
                </>
              )}
              {contextFields.map((f) => (
                <React.Fragment key={f.label}>
                  <dt>{f.label}</dt>
                  <dd data-testid={`session-${f.label.toLowerCase()}`}>{f.value}</dd>
                </React.Fragment>
              ))}
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
            {vitalsItems.length > 0 && <VitalsRow items={vitalsItems} />}
          </header>

          <div className={cx(styles.grid, !showTimeline ? styles.gridSingle : hasReplay && styles.gridWide)}>
            {showTimeline && (
              <section className={cx(styles.panel, styles.timelinePanel)} data-testid="panel-timeline">
                <h4 className={styles.h4}>
                  <Icon name="history" /> Timeline <span className={styles.muted}>({timeline.length} events)</span>
                </h4>
                <Timeline
                  timeline={timeline}
                  sessionStart={sessionStart}
                  activeIndex={activeIndex}
                  onSeek={hasReplay ? onTimelineSeek : undefined}
                  tapTimes={tapTimes}
                />
              </section>
            )}

            <section ref={replayPanelRef} className={cx(styles.panel, styles.replayPanel)} data-testid="panel-replay">
              <h4 className={styles.h4}>
                <Icon name="play" /> Replay
              </h4>
              {!session.has_replay && (
                <div className={styles.muted}>
                  {session.platform === 'mobile'
                    ? 'No replay was recorded for this session (mobile replay needs the native SDK with replay enabled).'
                    : 'No replay was recorded for this session.'}
                </div>
              )}
              {wantsReplay && replayError && !detail.error?.unauthorized && (
                <ApiErrorAlert
                  error={replayError}
                  onRetry={
                    metaError ? meta.reload : frames.error ? frames.reload : video.error ? video.reload : replay.reload
                  }
                />
              )}
              {replayLoading && (
                <LoadingPlaceholder
                  text={
                    renderer === 'frames'
                      ? 'Loading replay frames…'
                      : renderer === 'video'
                        ? 'Loading video replay…'
                        : 'Loading replay events…'
                  }
                />
              )}
              {showActivity && (
                <div className={styles.replayRow}>
                  {hasReplay && (
                    <div className={cx(styles.playerCol, hasRrweb && styles.playerColWide)}>
                      {hasRrweb && replay.data && (
                        <ReplayPlayer ref={playerRef} events={replay.data} onTime={setCurrentMs} />
                      )}
                      {hasFrames && frames.data && (
                        <FramePlayer
                          ref={playerRef}
                          frames={frames.data.frames}
                          touches={frames.data.touches ?? []}
                          viewport={frames.data.viewport}
                          startTs={bounds.start}
                          durationMs={bounds.durationMs}
                          onTime={setCurrentMs}
                          clockOffsetMs={clockOffsetMs}
                        />
                      )}
                      {hasVideo && video.data && (
                        <VideoPlayer
                          ref={playerRef}
                          manifest={video.data}
                          taps={taps}
                          startTs={bounds.start}
                          durationMs={bounds.durationMs}
                          onTime={setCurrentMs}
                          clockOffsetMs={clockOffsetMs}
                        />
                      )}
                    </div>
                  )}
                  <div className={cx(styles.activityCol, !hasReplay && styles.activityAlone)}>
                    <ReplayActivity
                      items={activity}
                      durationMs={hasReplay ? bounds.durationMs : 0}
                      currentMs={hasReplay ? currentMs : -1}
                      onSeek={hasReplay ? (ms) => seekTo(ms) : undefined}
                      clockStart={clockStart}
                    />
                  </div>
                </div>
              )}
              {hasReplay && (
                <ReplayMarkers
                  markers={markers}
                  durationMs={bounds.durationMs}
                  currentMs={currentMs}
                  onSeek={(ms) => seekTo(ms)}
                />
              )}
              {hasRrweb && replay.data && (
                <div className={styles.replayInfo}>
                  {replay.data.length} rrweb events · {formatDuration(bounds.durationMs)} · inputs are masked by the SDK
                  at record time · rendered in a sandboxed iframe
                </div>
              )}
              {hasFrames && frames.data && (
                <div className={styles.replayInfo}>
                  {frames.data.frames.length} frames · {(frames.data.touches ?? []).length} touches ·{' '}
                  {taps?.length ?? 0} taps · {formatDuration(bounds.durationMs)} · {frames.data.platform}{' '}
                  {frames.data.viewport.width}×{frames.data.viewport.height} pt · <MaskingBadge state={masking} />
                </div>
              )}
              {hasVideo && video.data && (
                <div className={styles.replayInfo}>
                  {video.data.segments.length} video segments · {totalFrames(video.data.segments)} frames ·{' '}
                  {taps?.length ?? 0} taps · {formatDuration(bounds.durationMs)} · {video.data.platform}{' '}
                  {video.data.viewport.width}×{video.data.viewport.height} px · <MaskingBadge state={masking} /> ·
                  segments stream through the plugin proxy
                </div>
              )}
              <FeedbackList items={feedback} clockStart={clockStart} onSeek={hasReplay ? onLogSeek : undefined} />
              {renderer === 'rrweb' && replay.data && replay.data.length === 0 && (
                <Alert severity="info" title="Replay is empty">
                  rum-api reports a replay for this session but no events were decodable.
                </Alert>
              )}
              {renderer === 'frames' && frames.data && frames.data.frames.length === 0 && (
                <Alert severity="info" title="Replay is empty">
                  rum-api reports a frames replay for this session but it holds no frames.
                </Alert>
              )}
              {renderer === 'video' && video.data && !video.data.segments?.length && (
                <Alert severity="info" title="Replay is empty">
                  rum-api reports a video replay for this session but it holds no segments.
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

          <section className={styles.panel} data-testid="panel-logs">
            <h4 className={styles.h4}>
              <Stack alignItems="center" gap={1}>
                <Icon name="gf-logs" /> Logs {logs.data && <span className={styles.muted}>({logs.data.count})</span>}
              </Stack>
            </h4>
            {logs.error && !detail.error?.unauthorized && <ApiErrorAlert error={logs.error} onRetry={logs.reload} />}
            {logs.loading && !logs.data && <LoadingPlaceholder text="Loading logs…" />}
            {logs.data && (
              <LogsPanel data={logs.data} sessionStart={sessionStart} onSeek={hasReplay ? onLogSeek : undefined} />
            )}
          </section>
        </>
      )}
    </PluginPage>
  );
}

/** The compact mobile vitals row of the header (spec section 8), each value coloured by its rating. */
function VitalsRow({ items }: { items: ReturnType<typeof vitalsHeaderItems> }) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  return (
    <div className={styles.vitals} data-testid="session-vitals">
      <span className={styles.muted}>Vitals</span>
      {items.map((it) => (
        <span key={it.key} className={styles.vital} data-testid={`vital-${it.key}`} data-rating={it.rating}>
          <span className={styles.muted}>{it.label}</span>{' '}
          <span style={{ color: ratingColor(it.rating)(theme) }} className={styles.vitalValue}>
            {it.value}
          </span>
        </span>
      ))}
    </div>
  );
}

const MASKING_BADGE = {
  masked: {
    text: 'masked',
    color: 'green',
    tooltip: 'The recording SDK masked text, inputs and images on the device before upload.',
  },
  unmasked: {
    text: 'not masked',
    color: 'orange',
    tooltip: 'The recording SDK reported masking off for at least one chunk: text and images are visible.',
  },
  unknown: {
    text: 'masking unknown',
    color: 'blue',
    tooltip: 'The replay chunks carry no masking flag (older SDK, bridge or rum-api).',
  },
} as const;

/** The replay's real masking state (C8), from the chunks' `masked` flag in the replay meta. */
export function MaskingBadge({ state }: { state: MaskingState }) {
  const b = MASKING_BADGE[state];
  return (
    <span data-testid="replay-masking" data-masking={state}>
      <Badge text={b.text} color={b.color} tooltip={b.tooltip} icon={state === 'masked' ? 'lock' : 'unlock'} />
    </span>
  );
}

/** Viewports narrower than this stack the Timeline and Replay panels. */
const STACKED = '@media (max-width: 899px)';

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
  vitals: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: theme.spacing(2),
    rowGap: theme.spacing(0.5),
    marginTop: theme.spacing(1),
  }),
  vital: css({ whiteSpace: 'nowrap' }),
  vitalValue: css({ fontWeight: theme.typography.fontWeightMedium }),
  meta: css({
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr max-content 1fr',
    columnGap: theme.spacing(2),
    rowGap: theme.spacing(0.5),
    margin: 0,
    dt: { color: theme.colors.text.secondary },
    dd: { margin: 0 },
  }),
  // Two columns: the Timeline panel scrolls inside itself (see Timeline) and the Replay panel is
  // pinned to the top of the page's scroll container while the page scrolls. Below 900px the
  // panels stack with the Replay first (the Timeline scrolls inside itself) and nothing is pinned.
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 2fr) minmax(360px, 3fr)',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
    [STACKED]: { gridTemplateColumns: '1fr' },
  }),
  // Feature toggle sessionTimelinePanel off: the Replay panel (player and activity list) alone.
  gridSingle: css({ gridTemplateColumns: 'minmax(0, 1fr)' }),
  // With the activity list inside the Replay panel, the panel needs the larger share.
  gridWide: css({
    gridTemplateColumns: 'minmax(280px, 1fr) minmax(560px, 2fr)',
    [STACKED]: { gridTemplateColumns: '1fr' },
  }),
  // Stretches to the row (the Replay panel's height when that is taller); the list inside scrolls.
  timelinePanel: css({ display: 'flex', flexDirection: 'column', minHeight: 0 }),
  replayPanel: css({
    position: 'sticky',
    top: theme.spacing(1),
    alignSelf: 'start',
    [STACKED]: { position: 'static', alignSelf: 'auto', order: -1 },
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
  link: css({ color: theme.colors.text.link, '&:hover': { textDecoration: 'underline' } }),
  // Player and activity list side by side; the list wraps under the player in a narrow panel.
  replayRow: css({ display: 'flex', flexWrap: 'wrap', gap: theme.spacing(1.5), alignItems: 'stretch' }),
  playerCol: css({ flex: '1 1 300px', minWidth: 0 }),
  // rrweb replays are wide (desktop viewports): the list wraps under the player sooner.
  playerColWide: css({ flex: '3 1 560px' }),
  // The list takes the player's height (it scrolls inside) instead of growing the row.
  activityCol: css({
    flex: '1 1 260px',
    maxWidth: 440,
    minHeight: 320,
    position: 'relative',
    '& > *': { position: 'absolute', inset: 0 },
  }),
  // Without a replay the list is the panel's content: full width, its own height.
  activityAlone: css({ maxWidth: 'none', flexBasis: '100%', height: 'min(560px, calc(100vh - 220px))' }),
  replayInfo: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(1),
  }),
});
