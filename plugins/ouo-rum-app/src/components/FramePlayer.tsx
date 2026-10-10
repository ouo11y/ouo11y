import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { IconButton, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import type { ReplayFrame, ReplayTouch, ReplayViewport } from '../api/types';
import { formatDuration, formatRelative } from '../utils/format';
import { clampOffset, frameIndexAt, stepFrameIndex, visibleTouches } from '../utils/frames';
import type { ReplayHandle } from './ReplayPlayer';

export type PlaybackSpeed = 1 | 2;

interface Props {
  frames: ReplayFrame[];
  touches: ReplayTouch[];
  viewport: ReplayViewport;
  /** Replay start (epoch ms); offsets are relative to it. */
  startTs: number;
  /** Replay length in ms (`ended_at - started_at`); the scrubber spans `[0, durationMs]`. */
  durationMs: number;
  /** Called with the current replay offset in ms, throttled while playing, immediately on seeks. */
  onTime?: (offsetMs: number) => void;
}

const SPEEDS: Array<{ label: string; value: PlaybackSpeed }> = [
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
];

/** Throttle for `onTime` while the clock advances (same cadence as the rrweb wrapper). */
const REPORT_EVERY_MS = 100;

/**
 * Frame-based replay for mobile sessions (ADR-0006): shows the latest frame at or before the
 * cursor, draws touches that fade over 500 ms, and exposes the same `goto`/`play`/`pause`
 * handle as the rrweb wrapper so markers and timeline clicks seek it the same way.
 */
export const FramePlayer = forwardRef<ReplayHandle, Props>(function FramePlayer(
  { frames, touches, viewport, startTs, durationMs, onTime },
  ref
) {
  const styles = useStyles2(getStyles);
  const [offsetMs, setOffsetMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const offsetRef = useRef(0);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const lastReportRef = useRef(0);

  // One data URL per frame, computed once; the base64 string is kept, nothing is decoded here.
  const urls = useMemo(() => frames.map((f) => `data:image/jpeg;base64,${f.jpeg}`), [frames]);

  const goto = useCallback(
    (ms: number) => {
      const next = clampOffset(ms, durationMs);
      offsetRef.current = next;
      setOffsetMs(next);
      lastReportRef.current = performance.now();
      onTimeRef.current?.(next);
    },
    [durationMs]
  );

  const play = useCallback(() => {
    if (durationMs <= 0) {
      return;
    }
    if (offsetRef.current >= durationMs) {
      goto(0);
    }
    setPlaying(true);
  }, [durationMs, goto]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  useImperativeHandle(ref, () => ({ goto, play, pause }), [goto, play, pause]);

  // Playback clock: requestAnimationFrame advances the offset by wall time × speed.
  useEffect(() => {
    if (!playing) {
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(durationMs, offsetRef.current + (now - last) * speed);
      last = now;
      offsetRef.current = next;
      setOffsetMs(next);
      if (now - lastReportRef.current >= REPORT_EVERY_MS || next >= durationMs) {
        lastReportRef.current = now;
        onTimeRef.current?.(next);
      }
      if (next >= durationMs) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, durationMs]);

  const cursorTs = startTs + offsetMs;
  const frameIndex = frameIndexAt(frames, cursorTs);
  const frame = frameIndex >= 0 ? frames[frameIndex] : undefined;
  const activeTouches = useMemo(() => visibleTouches(touches, viewport, cursorTs), [touches, viewport, cursorTs]);

  const stepFrame = useCallback(
    (delta: -1 | 1) => {
      if (frameIndex < 0) {
        return;
      }
      const currentStart = frames[frameIndex].ts - startTs;
      // Stepping back from the middle of a frame first snaps to that frame's start.
      if (delta === -1 && offsetRef.current > currentStart + 1) {
        goto(currentStart);
        return;
      }
      const next = stepFrameIndex(frames.length, frameIndex, delta);
      goto(frames[next].ts - startTs);
    },
    [frameIndex, frames, startTs, goto]
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
          stepFrame(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          stepFrame(1);
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
    [toggle, stepFrame, goto, durationMs]
  );

  if (!frames.length) {
    return <div className={styles.empty}>The replay has no frames yet.</div>;
  }

  const ratio = viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 9 / 19.5;
  // Portrait frames are height-limited: the stage is capped so the whole Replay panel (header,
  // controls, markers, info) fits the viewport and can stay pinned while the page scrolls.
  const stageWidth = `min(100%, calc(${STAGE_MAX_HEIGHT} * ${ratio}))`;

  return (
    <div
      className={styles.wrap}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="region"
      aria-label="Session replay (frames). Space plays or pauses, arrow keys step one frame."
      data-testid="frame-player"
    >
      <div
        className={styles.stage}
        style={{ aspectRatio: `${ratio}`, width: stageWidth }}
        data-testid="frame-stage"
      >
        {frame && (
          <img
            className={styles.img}
            src={urls[frameIndex]}
            alt={`Frame ${frameIndex + 1} of ${frames.length} (${frame.reason})`}
            draggable={false}
            data-testid="frame-img"
            data-frame-index={frameIndex}
          />
        )}
        {activeTouches.map((t, i) => (
          <span
            key={`${t.touch.ts}-${i}`}
            className={cx(styles.touch, t.touch.phase === 'ended' ? styles.touchEnded : styles.touchActive)}
            style={{ left: `${t.left * 100}%`, top: `${t.top * 100}%`, opacity: t.opacity }}
            data-testid="frame-touch"
            data-phase={t.touch.phase}
            aria-hidden="true"
          />
        ))}
      </div>

      <div className={styles.controls}>
        <IconButton
          name={playing ? 'pause' : 'play'}
          size="lg"
          tooltip={playing ? 'Pause (space)' : 'Play (space)'}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
          data-testid="frame-play"
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
          data-testid="frame-scrubber"
        />
        <span className={styles.time} data-testid="frame-time">
          {formatRelative(offsetMs)} / {formatDuration(durationMs)}
        </span>
        <RadioButtonGroup options={SPEEDS} value={speed} onChange={(v) => setSpeed(v)} size="sm" />
      </div>
      <div className={styles.info}>
        frame {frameIndex + 1}/{frames.length}
        {frame ? ` · ${frame.reason}` : ''} · {viewport.width}×{viewport.height} pt
      </div>
    </div>
  );
});

/** Viewport height minus the Grafana chrome and the Replay panel's own header, controls, markers and info line. */
// 70vh is the size users liked; the sticky Replay panel may extend past short viewports, which is
// preferable to a tiny frame.
const STAGE_MAX_HEIGHT = '70vh';

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
  img: css({
    display: 'block',
    width: '100%',
    height: '100%',
    // The stage already has the viewport's aspect ratio; fill maps touch points 1:1.
    objectFit: 'fill',
  }),
  touch: css({
    position: 'absolute',
    width: 28,
    height: 28,
    marginLeft: -14,
    marginTop: -14,
    borderRadius: '50%',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  }),
  touchActive: css({
    background: theme.colors.primary.transparent,
    border: `2px solid ${theme.colors.primary.main}`,
    boxShadow: `0 0 0 4px ${theme.colors.primary.transparent}`,
  }),
  touchEnded: css({
    border: `2px solid ${theme.colors.primary.main}`,
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
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.5),
  }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
});
