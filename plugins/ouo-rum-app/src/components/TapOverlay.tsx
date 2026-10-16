import React, { useMemo } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { tapLabel, visibleTaps, type ReplayTap } from '../utils/taps';

interface Props {
  taps: readonly ReplayTap[];
  /** Size of the space tap x/y are in (video pixels). */
  viewport: { width: number; height: number };
  /** Instant on screen (epoch ms). */
  cursorTs: number;
}

/**
 * Tap indicators over a video replay stage (which has the viewport's aspect ratio), drawn like
 * Sentry's player: a ripple at the tap position that stays for {@link TAP_WINDOW_MS} (fully visible
 * for the first second, so it survives the ~1 fps video), with the touched component as a label.
 * A tap known only from its `ui.tap` breadcrumb (no recorded position) shows as a label at the top
 * of the stage. Each indicator is keyed by its tap, so the ripple animation plays once when it
 * appears, also after a seek.
 */
export function TapOverlay({ taps, viewport, cursorTs }: Props) {
  const styles = useStyles2(getStyles);
  const active = useMemo(() => visibleTaps(taps, viewport, cursorTs), [taps, viewport, cursorTs]);
  const unplaced = active.filter((v) => v.left === undefined);
  return (
    <>
      {active.map((v) =>
        v.left === undefined || v.top === undefined ? null : (
          <span
            key={`tap-${v.tap.ts}-${v.tap.x}-${v.tap.y}`}
            className={styles.tap}
            style={{ left: `${v.left * 100}%`, top: `${v.top * 100}%`, opacity: v.opacity }}
            data-testid="video-tap"
            data-target={v.tap.target ?? ''}
            aria-hidden="true"
          >
            <span className={styles.ripple} />
            <span className={cx(styles.dot, v.tap.drag && styles.dragDot)} />
            {v.tap.target && (
              <span className={cx(styles.label, v.top > 0.85 ? styles.labelAbove : styles.labelBelow)}>
                {v.tap.target}
              </span>
            )}
          </span>
        )
      )}
      {unplaced.length > 0 && (
        <div className={styles.unplaced} aria-hidden="true">
          {unplaced.map((v) => (
            <span
              key={`tapl-${v.tap.ts}-${v.tap.timelineIndex ?? ''}`}
              className={styles.chip}
              style={{ opacity: v.opacity }}
              data-testid="video-tap-unplaced"
            >
              <Icon name="hand-pointer" size="sm" /> {tapLabel(v.tap)}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

const ripple = keyframes({
  from: { transform: 'scale(0.4)', opacity: 0.9 },
  to: { transform: 'scale(2.2)', opacity: 0 },
});
const pop = keyframes({
  from: { transform: 'scale(0.3)' },
  '60%': { transform: 'scale(1.15)' },
  to: { transform: 'scale(1)' },
});

const getStyles = (theme: GrafanaTheme2) => ({
  // Zero-size anchor at the tap point; children are centred on it.
  tap: css({
    position: 'absolute',
    zIndex: 3,
    width: 0,
    height: 0,
    pointerEvents: 'none',
  }),
  // White core with a dark halo and a Grafana-orange ring: shows on light, dark and coloured screens.
  dot: css({
    position: 'absolute',
    left: -18,
    top: -18,
    width: 36,
    height: 36,
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: 'rgba(255, 255, 255, 0.55)',
    border: '3px solid #ff7a1a',
    boxShadow: '0 0 0 2px rgba(255, 255, 255, 0.9), 0 0 0 4px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.4)',
    animation: `${pop} 250ms ease-out`,
    '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
  }),
  dragDot: css({ borderStyle: 'dashed' }),
  ripple: css({
    position: 'absolute',
    left: -24,
    top: -24,
    width: 48,
    height: 48,
    borderRadius: '50%',
    border: '3px solid #ff7a1a',
    opacity: 0,
    animation: `${ripple} 900ms ease-out`,
    '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
  }),
  label: css({
    position: 'absolute',
    left: 0,
    transform: 'translateX(-50%)',
    maxWidth: 180,
    padding: '1px 6px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: '#fff',
    background: 'rgba(0, 0, 0, 0.75)',
    borderRadius: theme.shape.radius.default,
    fontSize: 11,
    lineHeight: '16px',
  }),
  labelBelow: css({ top: 24 }),
  labelAbove: css({ bottom: 24 }),
  unplaced: css({
    position: 'absolute',
    zIndex: 3,
    left: theme.spacing(1),
    right: theme.spacing(1),
    top: theme.spacing(4),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    pointerEvents: 'none',
  }),
  chip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: '#fff',
    background: 'rgba(0, 0, 0, 0.75)',
    border: '2px solid #ff7a1a',
    borderRadius: 12,
    fontSize: 12,
  }),
});
