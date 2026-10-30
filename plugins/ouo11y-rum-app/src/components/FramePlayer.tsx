import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { IconButton, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import type { ReplayFrame, ReplayTouch, ReplayViewport } from '../api/types';
import { usePlaybackClock, type PlaybackSpeed } from '../hooks/usePlaybackClock';
import { formatDuration, formatRelative } from '../utils/format';
import { type DrawOp, frameDrawOps, frameIndexAt, paintOps, stepFrameIndex } from '../utils/frames';
import type { ReplayHandle } from './ReplayPlayer';
import { TouchOverlay } from './TouchOverlay';

export type { PlaybackSpeed };

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
  /**
   * Replay start minus session start (ms): the time label reads the session clock, like the Timeline
   * and the activity list. 0 (the default) shows replay offsets.
   */
  clockOffsetMs?: number;
}

export const SPEEDS: Array<{ label: string; value: PlaybackSpeed }> = [
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
];

/** Decoded images kept across renders, least recently used first (a few seconds of frames). */
const IMAGE_CACHE_SIZE = 64;
const imageCache = new Map<DrawOp, Promise<HTMLImageElement>>();

/** Decodes the op's JPEG once; ops are built once per replay, so the op itself is the key. */
function loadImage(op: DrawOp): Promise<HTMLImageElement> {
  let p = imageCache.get(op);
  if (p) {
    imageCache.delete(op);
  } else {
    const img = new Image();
    p = new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('frame image did not decode'));
      img.src = op.src;
    });
  }
  imageCache.set(op, p);
  if (imageCache.size > IMAGE_CACHE_SIZE) {
    imageCache.delete(imageCache.keys().next().value!);
  }
  return p;
}

/**
 * Draws a full image, sizing the canvas to it, then blits each patch in order. When the full image
 * did not decode, the canvas keeps what it showed; a patch that did not decode is skipped.
 */
function paint(canvas: HTMLCanvasElement, ops: DrawOp[], imgs: Array<HTMLImageElement | undefined>) {
  const ctx = canvas.getContext('2d');
  const base = imgs[0];
  if (!ctx || !base) {
    return;
  }
  ops.forEach((op, i) => {
    const img = imgs[i];
    if (!img) {
      return;
    }
    if (!op.rect) {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.drawImage(img, 0, 0);
    } else {
      ctx.drawImage(img, op.rect.x, op.rect.y, op.rect.w, op.rect.h);
    }
  });
}

/**
 * Frame-based replay for mobile sessions (ADR-0006, ADR-0014): paints the latest frame at or
 * before the cursor on a canvas (its full image, then the patch frames after it), draws touches
 * that fade over 500 ms, and exposes the same `goto`/`play`/`pause` handle as the rrweb wrapper
 * so markers and timeline clicks seek it the same way.
 */
export const FramePlayer = forwardRef<ReplayHandle, Props>(function FramePlayer(
  { frames, touches, viewport, startTs, durationMs, onTime, clockOffsetMs = 0 },
  ref
) {
  const styles = useStyles2(getStyles);
  const { offsetMs, offsetRef, playing, speed, setSpeed, goto, play, pause, toggle } = usePlaybackClock({
    durationMs,
    onTime,
  });

  // Data URLs per frame, computed once; images are decoded on demand by loadImage.
  const ops = useMemo(() => frameDrawOps(frames), [frames]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({ goto, play, pause }), [goto, play, pause]);

  const cursorTs = startTs + offsetMs;
  const frameIndex = frameIndexAt(frames, cursorTs);
  const frame = frameIndex >= 0 ? frames[frameIndex] : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    const todo = paintOps(ops, frameIndex);
    if (!canvas || !todo.length) {
      return;
    }
    let stale = false;
    Promise.all(todo.map((op) => loadImage(op).catch(() => undefined))).then((imgs) => {
      if (!stale) {
        paint(canvas, todo, imgs);
      }
    });
    return () => {
      stale = true;
    };
  }, [ops, frameIndex]);

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
    [frameIndex, frames, startTs, goto, offsetRef]
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
      <div className={styles.stage} style={{ aspectRatio: `${ratio}`, width: stageWidth }} data-testid="frame-stage">
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          role="img"
          aria-label={frame ? `Frame ${frameIndex + 1} of ${frames.length} (${frame.reason})` : undefined}
          data-testid="frame-canvas"
          data-frame-index={frameIndex}
        />
        <TouchOverlay touches={touches} viewport={viewport} cursorTs={cursorTs} testId="frame-touch" />
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
          {formatRelative(clockOffsetMs + offsetMs)} / {formatDuration(clockOffsetMs + durationMs)}
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

/**
 * Cap of the replay stage height (frame and video players). 70vh is the size users liked; the
 * sticky Replay panel may extend past short viewports, which is preferable to a tiny frame.
 */
export const STAGE_MAX_HEIGHT = '70vh';

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
  canvas: css({
    display: 'block',
    width: '100%',
    height: '100%',
    // The stage already has the viewport's aspect ratio; fill maps touch points 1:1.
    objectFit: 'fill',
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
