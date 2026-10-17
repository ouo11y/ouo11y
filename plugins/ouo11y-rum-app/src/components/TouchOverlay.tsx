import React, { useMemo } from 'react';
import { css, cx } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import type { ReplayTouch } from '../api/types';
import { visibleTouches } from '../utils/frames';

interface Props {
  touches: readonly ReplayTouch[];
  /** Size of the space touch x/y are in (frame points, or video pixels). */
  viewport: { width: number; height: number };
  /** Instant on screen (epoch ms). */
  cursorTs: number;
  /** `data-testid` of each touch dot. */
  testId: string;
  /** How long a touch stays visible while it fades (ms). */
  windowMs?: number;
}

/**
 * Touch indicators over a replay stage that has the viewport's aspect ratio: each touch is placed at
 * `x / width`, `y / height` of the rendered stage and fades out over `windowMs` (default 500 ms).
 * The dot is white with a dark halo so it shows on any screen colour (a theme-coloured ring vanished
 * on the demo's purple buttons).
 */
export function TouchOverlay({ touches, viewport, cursorTs, testId, windowMs }: Props) {
  const styles = useStyles2(getStyles);
  const active = useMemo(
    () => visibleTouches(touches, viewport, cursorTs, windowMs),
    [touches, viewport, cursorTs, windowMs]
  );
  return (
    <>
      {active.map((t, i) => (
        <span
          key={`${t.touch.ts}-${i}`}
          className={cx(styles.touch, t.touch.phase === 'ended' ? styles.touchEnded : styles.touchActive)}
          style={{ left: `${t.left * 100}%`, top: `${t.top * 100}%`, opacity: t.opacity }}
          data-testid={testId}
          data-phase={t.touch.phase}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

const getStyles = () => ({
  touch: css({
    position: 'absolute',
    zIndex: 2,
    width: 32,
    height: 32,
    marginLeft: -16,
    marginTop: -16,
    borderRadius: '50%',
    pointerEvents: 'none',
    boxSizing: 'border-box',
    border: '3px solid #fff',
    // Dark halo inside and outside the white ring: visible on light and dark screens alike.
    boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.55), inset 0 0 0 2px rgba(0, 0, 0, 0.35)',
  }),
  touchActive: css({
    background: 'rgba(255, 255, 255, 0.45)',
  }),
  touchEnded: css({
    background: 'transparent',
  }),
});
