import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Badge, IconButton, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { videoSegmentUrl } from '../api/client';
import type { ReplayTouch, VideoManifest, VideoSegment } from '../api/types';
import { usePlaybackClock, type PlaybackSpeed } from '../hooks/usePlaybackClock';
import { formatDuration, formatRelative } from '../utils/format';
import { buildTaps, type ReplayTap } from '../utils/taps';
import {
  frameStepMs,
  locateSegment,
  mediaErrorText,
  mediaPending,
  mountedSegmentIndices,
  orderSegments,
  segmentStartOffset,
  syncMediaElement,
  totalFrames,
} from '../utils/video';
import { SPEEDS, STAGE_MAX_HEIGHT } from './FramePlayer';
import type { ReplayHandle } from './ReplayPlayer';
import { TapOverlay } from './TapOverlay';
import { TouchOverlay } from './TouchOverlay';

interface Props {
  manifest: VideoManifest;
  /** Replay start (epoch ms, manifest `started_at`); offsets are relative to it. */
  startTs: number;
  /** Replay length in ms (`ended_at - started_at`); the scrubber spans `[0, durationMs]`. */
  durationMs: number;
  /** Called with the current replay offset in ms, throttled while playing, immediately on seeks. */
  onTime?: (offsetMs: number) => void;
  /** Browser URL of a segment; defaults to the plugin proxy route (tests override it). */
  segmentUrl?: (segment: VideoSegment) => string;
  /**
   * Taps to draw (`buildTaps` of the manifest's touches and the session's `ui.tap` events); defaults
   * to the manifest's touches alone.
   */
  taps?: readonly ReplayTap[];
}

const VENDOR_LABEL: Record<string, string> = { sentry: 'Sentry replay' };

/**
 * Video replay (ADR-0008, kind `video`): mp4 segments played in seq order as one timeline from the
 * manifest's `started_at` to `ended_at`. The replay clock (shared with the frame player) is the
 * master; the `<video>` of the segment under the cursor follows it, the next segment is mounted
 * hidden so it preloads, and a gap between segments keeps the previous segment's last frame.
 * Exposes the same `goto`/`play`/`pause` handle as the other players for markers and the timeline.
 */
/**
 * Sentry mobile replay records about 1 frame per second, so a 500 ms touch could appear and vanish
 * between two frames: video replays keep the trail of a drag on screen for 1.5 s (taps themselves
 * are drawn by `TapOverlay`, see `TAP_WINDOW_MS`).
 */
export const VIDEO_TOUCH_WINDOW_MS = 1500;

const isMove = (t: ReplayTouch) => t.phase === 'moved';

export const VideoPlayer = forwardRef<ReplayHandle, Props>(function VideoPlayer(
  { manifest, startTs, durationMs, onTime, segmentUrl, taps: tapsProp },
  ref
) {
  const styles = useStyles2(getStyles);
  const segments = useMemo(() => orderSegments(manifest.segments), [manifest.segments]);
  const touches = useMemo(() => manifest.touches ?? [], [manifest.touches]);
  const moves = useMemo(() => touches.filter(isMove), [touches]);
  const taps = useMemo(() => tapsProp ?? buildTaps(touches, []), [tapsProp, touches]);
  const urlFor = useCallback(
    (seg: VideoSegment) => (segmentUrl ? segmentUrl(seg) : videoSegmentUrl(manifest.session_id, seg)),
    [segmentUrl, manifest.session_id]
  );

  const videosRef = useRef(new Map<number, HTMLVideoElement>());
  const playingRef = useRef(false);
  const speedRef = useRef<PlaybackSpeed>(1);
  const [ready, setReady] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, string>>({});

  /** Points the segment under `offsetMs` at the cursor and pauses every other mounted segment. */
  const syncMedia = useCallback(
    (offsetMs: number) => {
      const pos = locateSegment(segments, startTs + offsetMs);
      const active = pos.index >= 0 ? segments[pos.index] : undefined;
      videosRef.current.forEach((el, seq) => {
        if (seq !== active?.seq && !el.paused) {
          el.pause();
        }
      });
      const el = active ? videosRef.current.get(active.seq) : undefined;
      if (el) {
        syncMediaElement(el, pos, playingRef.current, speedRef.current);
      }
    },
    [segments, startTs]
  );

  /** The clock waits (bounded) while the segment under the cursor has no frame yet. */
  const holdForMedia = useCallback(
    (offsetMs: number) => {
      const pos = locateSegment(segments, startTs + offsetMs);
      const el = pos.index >= 0 ? videosRef.current.get(segments[pos.index].seq) : undefined;
      return mediaPending(el, pos);
    },
    [segments, startTs]
  );

  const { offsetMs, offsetRef, playing, speed, setSpeed, goto, play, pause, toggle } = usePlaybackClock({
    durationMs,
    onTime,
    hold: holdForMedia,
    onAdvance: syncMedia,
  });

  useImperativeHandle(ref, () => ({ goto, play, pause }), [goto, play, pause]);

  // Play/pause and speed changes reach the media elements here; ticks and seeks go through onAdvance.
  useEffect(() => {
    playingRef.current = playing;
    speedRef.current = speed;
    syncMedia(offsetRef.current);
  }, [playing, speed, syncMedia, offsetRef]);

  // One stable ref callback per seq, so React does not detach and reattach elements on every render;
  // they call the latest syncMedia through a ref.
  const syncRef = useRef(syncMedia);
  useEffect(() => {
    syncRef.current = syncMedia;
  }, [syncMedia]);
  const refCache = useRef(new Map<number, (el: HTMLVideoElement | null) => void>());
  const videoRef = useCallback(
    (seq: number) => {
      let cb = refCache.current.get(seq);
      if (!cb) {
        cb = (el: HTMLVideoElement | null) => {
          if (el) {
            videosRef.current.set(seq, el);
            syncRef.current(offsetRef.current);
          } else {
            videosRef.current.delete(seq);
          }
        };
        refCache.current.set(seq, cb);
      }
      return cb;
    },
    [offsetRef]
  );

  const onLoaded = useCallback(
    (seq: number) => {
      setReady((r) => (r[seq] ? r : { ...r, [seq]: true }));
      syncMedia(offsetRef.current);
    },
    [syncMedia, offsetRef]
  );
  const onFailed = useCallback((seq: number, el: HTMLVideoElement) => {
    const text = mediaErrorText(el.error);
    setFailed((f) => (f[seq] === text ? f : { ...f, [seq]: text }));
  }, []);

  const cursorTs = startTs + offsetMs;
  const pos = locateSegment(segments, cursorTs);
  const activeSeg = pos.index >= 0 ? segments[pos.index] : undefined;
  const mounted = mountedSegmentIndices(segments.length, pos.index);

  const stepFrame = useCallback(
    (delta: -1 | 1) => {
      goto(offsetRef.current + delta * frameStepMs(activeSeg));
    },
    [goto, offsetRef, activeSeg]
  );
  const stepSegment = useCallback(
    (delta: -1 | 1) => {
      if (pos.index < 0) {
        return;
      }
      const current = segmentStartOffset(segments[pos.index], startTs);
      // Back from the middle of a segment first returns to its start, like the frame player.
      if (delta === -1 && offsetRef.current > current + 1) {
        goto(current);
        return;
      }
      const next = Math.min(segments.length - 1, Math.max(0, pos.index + delta));
      goto(segmentStartOffset(segments[next], startTs));
    },
    [pos.index, segments, startTs, goto, offsetRef]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && e.key !== ' ') {
        return; // let the range input handle its own arrow keys
      }
      switch (e.key) {
        case ' ':
          e.preventDefault();
          toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            stepSegment(-1);
          } else {
            stepFrame(-1);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            stepSegment(1);
          } else {
            stepFrame(1);
          }
          break;
        case 'Home':
          e.preventDefault();
          goto(0);
          break;
        case 'End':
          e.preventDefault();
          goto(durationMs);
          break;
        default:
      }
    },
    [toggle, stepFrame, stepSegment, goto, durationMs]
  );

  if (!segments.length) {
    return <div className={styles.empty}>The replay has no video segments yet.</div>;
  }

  const { viewport } = manifest;
  const ratio = viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 9 / 19.5;
  const stageWidth = `min(100%, calc(${STAGE_MAX_HEIGHT} * ${ratio}))`;
  const activeError = activeSeg ? failed[activeSeg.seq] : undefined;
  const beforeFirst = pos.inGap && pos.index === 0 && cursorTs < segments[0].started_at;
  const vendor = manifest.source?.vendor;
  const vendorLabel = vendor ? (VENDOR_LABEL[vendor] ?? `${vendor} replay`) : null;

  return (
    <div
      className={styles.wrap}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="region"
      aria-label="Session replay (video). Space plays or pauses, arrow keys step one frame, shift+arrow one segment."
      data-testid="video-player"
    >
      <div
        className={styles.stage}
        style={{ aspectRatio: `${ratio}`, width: stageWidth }}
        data-testid="video-stage"
        data-segment-index={pos.index}
        data-in-gap={pos.inGap}
      >
        {mounted.map((i) => {
          const seg = segments[i];
          const isActive = i === pos.index;
          return (
            <video
              key={seg.seq}
              ref={videoRef(seg.seq)}
              className={cx(styles.video, !isActive && styles.preloading)}
              src={urlFor(seg)}
              preload="auto"
              muted
              playsInline
              disablePictureInPicture
              aria-hidden={!isActive}
              data-testid="video-segment"
              data-seq={seg.seq}
              data-active={isActive}
              onLoadedData={() => onLoaded(seg.seq)}
              onError={(e) => onFailed(seg.seq, e.currentTarget)}
            />
          );
        })}
        {activeSeg && activeError && (
          <div className={styles.notice} data-testid="video-error">
            Segment {activeSeg.seq} could not be played: {activeError}. Taps and the timeline still follow the clock.
          </div>
        )}
        {activeSeg && !activeError && !ready[activeSeg.seq] && (
          <div className={styles.notice} data-testid="video-loading">
            Loading segment {activeSeg.seq}…
          </div>
        )}
        {pos.inGap && !activeError && (
          <div className={styles.gapTag} data-testid="video-gap">
            no video here · showing the {beforeFirst ? 'first' : 'last'} frame
          </div>
        )}
        <TapOverlay taps={taps} viewport={viewport} cursorTs={cursorTs} />
        <TouchOverlay
          touches={moves}
          viewport={viewport}
          cursorTs={cursorTs}
          testId="video-touch"
          windowMs={VIDEO_TOUCH_WINDOW_MS}
        />
      </div>

      <div className={styles.controls}>
        <IconButton
          name={playing ? 'pause' : 'play'}
          size="lg"
          tooltip={playing ? 'Pause (space)' : 'Play (space)'}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
          data-testid="video-play"
        />
        <input
          type="range"
          className={styles.range}
          min={0}
          max={Math.max(0, Math.round(durationMs))}
          step={1}
          value={Math.round(offsetMs)}
          onChange={(e) => goto(Number(e.currentTarget.value))}
          aria-label="Replay position"
          data-testid="video-scrubber"
        />
        <span className={styles.time} data-testid="video-time">
          {formatRelative(offsetMs)} / {formatDuration(durationMs)}
        </span>
        <RadioButtonGroup options={SPEEDS} value={speed} onChange={(v) => setSpeed(v)} size="sm" />
      </div>
      <div className={styles.info}>
        {vendorLabel && (
          <span data-testid="video-source" data-vendor={vendor}>
            <Badge
              text={vendorLabel}
              color="purple"
              tooltip={
                manifest.source?.replay_id
                  ? `Recorded by the ${vendor} SDK, replay_id ${manifest.source.replay_id}`
                  : `Recorded by the ${vendor} SDK`
              }
            />
          </span>
        )}
        <span>
          segment {pos.index + 1}/{segments.length}
          {activeSeg ? ` (seq ${activeSeg.seq})` : ''} · {totalFrames(segments)} frames · {viewport.width}×
          {viewport.height} px
        </span>
      </div>
    </div>
  );
});

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({
    width: '100%',
    outline: 'none',
    '&:focus-visible': { boxShadow: `0 0 0 2px ${theme.colors.primary.border}` },
    borderRadius: theme.shape.radius.default,
  }),
  stage: css({
    position: 'relative',
    margin: '0 auto',
    maxHeight: STAGE_MAX_HEIGHT,
    background: theme.colors.background.canvas,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
    userSelect: 'none',
  }),
  video: css({
    position: 'absolute',
    inset: 0,
    display: 'block',
    width: '100%',
    height: '100%',
    // The stage already has the video's aspect ratio; fill maps touch points 1:1.
    objectFit: 'fill',
    background: theme.colors.background.canvas,
  }),
  // Mounted (so the browser fetches and decodes it) but not painted until it becomes the active one.
  preloading: css({ visibility: 'hidden' }),
  notice: css({
    position: 'absolute',
    zIndex: 1,
    left: theme.spacing(1),
    right: theme.spacing(1),
    top: '50%',
    transform: 'translateY(-50%)',
    padding: theme.spacing(1),
    textAlign: 'center',
    color: theme.colors.text.secondary,
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  gapTag: css({
    position: 'absolute',
    zIndex: 1,
    left: theme.spacing(1),
    top: theme.spacing(1),
    padding: theme.spacing(0.25, 0.75),
    color: theme.colors.text.secondary,
    background: theme.colors.background.primary,
    borderRadius: theme.shape.radius.default,
    fontSize: theme.typography.bodySmall.fontSize,
    opacity: 0.9,
  }),
  controls: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  }),
  range: css({
    flex: 1,
    minWidth: 0,
    accentColor: theme.colors.primary.main,
    cursor: 'pointer',
  }),
  time: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    whiteSpace: 'nowrap',
  }),
  info: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.5),
  }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
});
