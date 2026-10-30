import React from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Tooltip, useStyles2 } from '@grafana/ui';
import type { MarkerKind, ReplayMarker } from '../utils/markers';
import { formatRelative } from '../utils/format';

interface Props {
  markers: ReplayMarker[];
  durationMs: number;
  currentMs: number;
  onSeek: (offsetMs: number, marker: ReplayMarker) => void;
}

const KIND_LABEL: Record<MarkerKind, string> = {
  crash: 'Fatal error',
  error: 'Error',
  failed_request: 'Failed request',
  navigation: 'Navigation',
  tap: 'Tap',
  feedback: 'Feedback',
};

export function ReplayMarkers({ markers, durationMs, currentMs, onSeek }: Props) {
  const styles = useStyles2(getStyles);
  const cursorPct = durationMs > 0 ? Math.min(100, Math.max(0, (currentMs / durationMs) * 100)) : 0;
  return (
    <div className={styles.wrap} data-testid="replay-markers">
      <div className={styles.bar}>
        <div className={styles.cursor} style={{ left: `${cursorPct}%` }} />
        {markers.map((m) => (
          <Tooltip key={m.key} content={`${KIND_LABEL[m.kind]} ${formatRelative(m.offsetMs)} — ${m.label}`}>
            <button
              type="button"
              className={cx(styles.tick, m.kind === 'tap' && styles.tapTick, styles[m.kind])}
              style={{ left: `${m.leftPct}%` }}
              onClick={() => onSeek(Math.max(0, Math.min(durationMs, m.offsetMs)), m)}
              aria-label={`${KIND_LABEL[m.kind]} at ${formatRelative(m.offsetMs)}`}
              data-marker-kind={m.kind}
              data-marker-index={m.index}
            />
          </Tooltip>
        ))}
      </div>
      <div className={styles.legend}>
        <span>
          <i className={cx(styles.dot, styles.tap)} /> tap
        </span>
        <span>
          <i className={cx(styles.dot, styles.crash)} /> fatal
        </span>
        <span>
          <i className={cx(styles.dot, styles.error)} /> error
        </span>
        <span>
          <i className={cx(styles.dot, styles.failed_request)} /> failed request
        </span>
        <span>
          <i className={cx(styles.dot, styles.navigation)} /> navigation
        </span>
        <span>
          <i className={cx(styles.dot, styles.feedback)} /> feedback
        </span>
        <span className={styles.time}>{formatRelative(currentMs)}</span>
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({ marginTop: theme.spacing(1) }),
  bar: css({
    position: 'relative',
    height: 18,
    margin: theme.spacing(0, 1),
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
  }),
  cursor: css({
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    background: theme.colors.text.primary,
    opacity: 0.7,
    pointerEvents: 'none',
  }),
  tick: css({
    position: 'absolute',
    top: 2,
    width: 10,
    height: 14,
    marginLeft: -5,
    border: 'none',
    borderRadius: 2,
    padding: 0,
    cursor: 'pointer',
    opacity: 0.9,
    '&:hover': { opacity: 1, transform: 'scaleY(1.15)' },
  }),
  crash: css({ background: theme.colors.error.main }),
  error: css({ background: theme.colors.warning.main }),
  failed_request: css({ background: theme.colors.warning.shade }),
  navigation: css({ background: theme.colors.primary.main }),
  feedback: css({ background: theme.colors.success.main }),
  // Taps are frequent: a thin, round-topped tick in the tap indicator's orange, under the other kinds.
  tap: css({ background: '#ff7a1a' }),
  tapTick: css({ width: 6, marginLeft: -3, borderRadius: 3 }),
  legend: css({
    display: 'flex',
    gap: theme.spacing(2),
    alignItems: 'center',
    padding: theme.spacing(0.5, 1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  dot: css({ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 4 }),
  time: css({ marginLeft: 'auto', fontFamily: theme.typography.fontFamilyMonospace }),
});
