import React, { useMemo } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
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
}

/**
 * Touch indicators over a replay stage that has the viewport's aspect ratio: each touch is placed at
 * `x / width`, `y / height` of the rendered stage and fades out over 500 ms (frame and video players).
 */
export function TouchOverlay({ touches, viewport, cursorTs, testId }: Props) {
  const styles = useStyles2(getStyles);
  const active = useMemo(() => visibleTouches(touches, viewport, cursorTs), [touches, viewport, cursorTs]);
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

const getStyles = (theme: GrafanaTheme2) => ({
  touch: css({
    position: 'absolute',
    zIndex: 2,
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
});
